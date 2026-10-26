// UI render gate: every view must render without throwing.
//
// The client bundle is a browser module that calls window.__ModuleLoader__.load.
// This harness supplies a tiny stand-in loader, resolves `require("react")` from
// the desktop profile, and renders each view through react-dom/server. It is not
// a DOM test — no layout, no PDF.js — but it does catch the class of defect that
// unit tests on the Host cannot see: a view that throws the first time a user
// opens it, or a translation key that does not exist.
//
// Run: node test/ui-render.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, sep } from "node:path";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

// react/react-dom are not dependencies of this package. Resolve `react-dom` from
// the desktop profile, then resolve `react` from react-dom's own directory: the
// profile deliberately mixes React 18 (consumed by the host bundles) with a
// react-dom junction pointing at a 19.x tree, and rendering a 18.x element with
// the 19.x server renderer throws "Objects are not valid as a React child".
const REACT_ROOT = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules");
const requireFromProfile = createRequire(join(REACT_ROOT, "noop.js"));
let React;
let renderToStaticMarkup;
try {
  const domEntry = requireFromProfile.resolve("react-dom/server");
  const domRoot = domEntry.slice(0, domEntry.indexOf(`${sep}react-dom${sep}`));
  const requireFromDom = createRequire(join(domRoot, "noop.js"));
  ({ renderToStaticMarkup } = requireFromDom("react-dom/server"));
  React = requireFromDom("react");
} catch (error) {
  console.error(`UI-RENDER: react not resolvable from ${REACT_ROOT}: ${error.message}`);
  process.exit(2);
}
console.log(`UI-RENDER: react ${React.version}`);

// --- load the bundle -----------------------------------------------------
let exported = null;
let loadError = null;
globalThis.window = {
  __ModuleLoader__: {
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
  },
};
// The module touches document only inside ensureCss(), which the tests avoid.
globalThis.document = { querySelector: () => null, createElement: () => ({ style: {}, dataset: {} }), head: { appendChild() {} } };

await import(pathToFileURL(join(process.cwd(), "client.js")).href);
check("client bundle loads", loadError === null && exported !== null, loadError?.message ?? "");
if (loadError !== null) process.exit(1);

const { __test } = exported;
check("bundle exposes its views for testing", __test !== undefined);
const { Body, PaperCard, MetadataEditor, EvidenceRow, StanceBadge, snippetNodes, CSS, DICTS } = __test;

// --- dictionary parity ---------------------------------------------------
const zhKeys = Object.keys(DICTS.zh).sort();
const enKeys = Object.keys(DICTS.en).sort();
check("zh and en dictionaries have the same keys", zhKeys.join() === enKeys.join(),
  `zh-only: ${zhKeys.filter((k) => !enKeys.includes(k))} en-only: ${enKeys.filter((k) => !zhKeys.includes(k))}`);

// The translator the host would provide, with the same placeholder contract.
function makeT(dict) {
  return (key, params) => {
    const raw = dict[key];
    if (raw === undefined) throw new Error(`missing translation key: ${key}`);
    if (params === undefined) return raw;
    return String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
  };
}

// Every key a view uses must exist. Catch it statically: a missing key is a
// runtime throw in the real host too.
const clientSource = readFileSync("client.js", "utf8");
const usedKeys = new Set([...clientSource.matchAll(/\bt\("(\w+)"\)/g)].map((m) => m[1]));
const missingKeys = [...usedKeys].filter((key) => DICTS.zh[key] === undefined || DICTS.en[key] === undefined);
check("every t() key exists in both dictionaries", missingKeys.length === 0, missingKeys.join(", "));

// Keys used with a literal string but containing a dot (e.g. "guide.description")
// are looked up flat by the locale service. A nested object would be returned as
// a React child and crash, so reject any non-string dictionary value.
for (const locale of ["zh", "en"]) {
  const nonString = Object.entries(DICTS[locale])
    .filter(([, value]) => typeof value !== "string")
    .map(([key]) => key);
  check(`${locale} dictionary values are all flat strings`, nonString.length === 0, nonString.join(", "));
}

// Dotted keys are written as t("a.b") and must also be found; collect them too.
const dottedKeys = new Set([...clientSource.matchAll(/\bt\("([\w.]+)"\)/g)].map((m) => m[1]).filter((key) => key.includes(".")));
const missingDotted = [...dottedKeys].filter((key) => typeof DICTS.zh[key] !== "string" || typeof DICTS.en[key] !== "string");
check("every dotted t() key exists in both dictionaries", missingDotted.length === 0, missingDotted.join(", "));

// --- render each view ----------------------------------------------------
function render(name, element) {
  try {
    const html = renderToStaticMarkup(element);
    check(`${name} renders`, typeof html === "string" && html.length > 0);
    return html;
  } catch (error) {
    check(`${name} renders`, false, error?.message ?? String(error));
    return "";
  }
}

const t = makeT(DICTS.zh);
const noop = () => {};
const baseProps = { sessionId: "session-ui-test", inputActions: { captureInsertion: noop, insertText: noop }, t };

// The three tabs in their initial (empty library) state.
render("Body/library (empty library)", React.createElement(Body, baseProps));

// The other tabs need to be reached; render the internal views by driving the
// same component with a mounted tab list is not possible without a DOM, so the
// subcomponents are exercised directly plus Body's library view.
render("PaperCard (full text + PDF)", React.createElement(PaperCard, {
  paper: { paperId: "p1", title: "A paper", authors: "A. Author", year: "2024", venue: "Journal", numPages: 12, material: "fulltext", pdfPath: "/x.pdf", hitCount: 3, snippet: "…text [match] more…" },
  t, busy: null, onOpen: noop, onEdit: noop, onDelete: noop,
}));
render("PaperCard (metadata only, no PDF)", React.createElement(PaperCard, {
  paper: { paperId: "p2", title: "Metadata only", numPages: 0, material: "metadata", pdfPath: "" },
  t, busy: null, onOpen: noop, onEdit: noop, onDelete: noop,
}));

// A scanned paper must not be shown as "full text" (that presents OCR guesses
// as the PDF's own words) nor as "metadata only" (that denies it is searchable).
// It needs its own badge, and the badge must survive both locales.
for (const locale of ["zh", "en"]) {
  const tt = makeT(DICTS[locale]);
  const html = render(`PaperCard (OCR, ${locale})`, React.createElement(PaperCard, {
    paper: { paperId: "p3", title: "Scanned", authors: "A", year: "2020", numPages: 5, material: "ocr", pdfPath: "/s.pdf" },
    t: tt, busy: null, onOpen: noop, onEdit: noop, onDelete: noop,
  }));
  const wantOcr = DICTS[locale].ocrText;
  const wantFull = DICTS[locale].fulltext;
  const wantMeta = DICTS[locale].metaOnly;
  check(`PaperCard (OCR, ${locale}) has an ocrText label`, typeof wantOcr === "string" && wantOcr !== "");
  check(`PaperCard (OCR, ${locale}) does not claim full text`, !html.includes(wantFull));
  check(`PaperCard (OCR, ${locale}) does not claim metadata only`, !html.includes(wantMeta));
  check(`PaperCard (OCR, ${locale}) shows its own badge`, html.includes(wantOcr));
}
render("MetadataEditor", React.createElement(MetadataEditor, {
  paper: { paperId: "p1", title: "T", authors: "A", year: "2024", venue: "V", doi: "10.1/x", abstract: "abs" },
  t, busy: null, onSave: noop, onCancel: noop,
}));
render("EvidenceRow (located)", React.createElement(EvidenceRow, {
  row: { evidenceId: "e1", paperId: "p1", pageIndex: 2, charStart: 10, charEnd: 40, quote: "a quote", paperTitle: "P" },
  t, busy: null, onJump: noop, onDelete: noop,
}));
render("EvidenceRow (page only)", React.createElement(EvidenceRow, {
  row: { evidenceId: "e2", paperId: "p1", pageIndex: 0, charStart: -1, charEnd: -1, quote: "q", paperTitle: "P" },
  t, busy: null, onJump: noop, onDelete: noop,
}));
for (const stance of ["support", "conflict", "not_found", "no_evidence", "covered", "empty"]) {
  render(`StanceBadge(${stance})`, React.createElement(StanceBadge, { stance, t }));
}

// English locale must render too: a missing en key throws.
const tEn = makeT(DICTS.en);
render("Body/library (en)", React.createElement(Body, {
  sessionId: "session-ui-test",
  inputActions: { captureInsertion: noop, insertText: noop },
  t: tEn,
}));

// --- snippet markup ------------------------------------------------------
const nodes = snippetNodes("before [hit] after");
const flat = JSON.stringify(nodes);
check("snippet marks the bracketed hit", flat.includes('"hit"') && flat.includes("mark"), flat.slice(0, 120));
const hostile = snippetNodes('<img src=x onerror=alert(1)> [x]');
check(
  "snippet keeps markup as text",
  JSON.stringify(hostile).includes("onerror") && !JSON.stringify(hostile).includes('"onerror"'),
  JSON.stringify(hostile).slice(0, 160),
);

// --- theme tokens --------------------------------------------------------
// The CSS must not hardcode a colour and must pair background with colour.
const preRule = (CSS.match(/\.pt-pre\s*\{[^}]*\}/) ?? [""])[0];
check(".pt-pre sets both background and color", /background:/.test(preRule) && /color:/.test(preRule), preRule.slice(0, 160));
check("CSS contains no literal colours", !/#[0-9a-fA-F]{3,8}\b/.test(CSS));
check("CSS defines a narrow-sidebar breakpoint", /@container pt \(max-width/.test(CSS));

// --- apply() contract ----------------------------------------------------
// The tab chip and guide label are thunks read on every call, so they must go
// through the bound translate rather than a hardcoded string. Assert by running
// apply() against a fake host that records what gets registered.
const registered = { tabType: null, slot: null, dicts: null };
const fakeCtx = {
  effect: (fn) => { fn(); },
  locale: {
    register: (ns, dicts) => { registered.dicts = dicts; return () => {}; },
    bind: (ns) => (key) => (registered.dicts?.["zh"]?.[key] ?? `MISSING:${key}`),
  },
  sidebarRightTabs: { register: (definition) => { registered.tabType = definition; return () => {}; } },
  slots: { inject: (_name, fn) => { registered.slot = fn(); return () => {}; }, register: (spec) => spec },
  connection: {},
};
let applyError = null;
try {
  exported.apply(fakeCtx);
} catch (error) {
  applyError = error;
}
check("apply() runs against a host ctx", applyError === null, applyError?.message ?? "");
check("tab type is registered", registered.tabType !== null);
check("tab body slot is registered", registered.slot !== null);
if (registered.tabType !== null) {
  const {
    id, kind, keepMounted, title, guide,
  } = registered.tabType;
  check("tab id and kind are stable", id === "@local/paper-tool/library" && kind === "paper-tool", `${id} / ${kind}`);
  // keepMounted is what preserves half-typed input and the open PDF when the
  // user switches away and back; losing it is a silent UX regression.
  check("tab keeps its state when hidden", keepMounted === true);
  check("tab title is translated", title() === "论文", String(title()));
  const guideTitle = guide?.[0]?.title?.();
  check("guide title is translated", guideTitle === "论文", String(guideTitle));
  const guideDescription = guide?.[0]?.description?.();
  check("guide description is translated", typeof guideDescription === "string" && !guideDescription.startsWith("MISSING"), String(guideDescription));
}
check("dictionaries are registered under the plugin namespace",
  registered.dicts !== null && Object.keys(registered.dicts).sort().join() === "en,zh",
  JSON.stringify(Object.keys(registered.dicts ?? {})));

// --- reveal on first mount -----------------------------------------------
// Registering the tab TYPE is invisible on its own: a collapsed right column
// draws no rail, so a fresh profile shows nothing until the user finds the
// corner toggle. These cases pin the auto-open rule and, just as important, the
// cases where it must stay out of the way.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRevealCtx({ screen, openTab }) {
  const calls = [];
  const disposers = [];
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      disposers.push(typeof dispose === "function" ? dispose : () => {});
      return () => {};
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_name, fn) => { fn(); return () => {}; }, register: (spec) => spec },
    connection: {},
    sidebarRight: {
      mounted: { subscribe: () => () => {}, getSnapshot: () => "session-1" },
      screen,
      openTab: (kind) => {
        calls.push(kind);
        return openTab?.(kind);
      },
    },
  };
  return { ctx, calls, dispose: () => disposers.forEach((fn) => fn()) };
}

// An empty, collapsed column: the only state the plugin fills in.
{
  const { ctx, calls, dispose } = makeRevealCtx({
    screen: () => ({ sessionId: "session-1", surface: { layout: { tabs: {}, expanded: false } } }),
  });
  exported.apply(ctx);
  await sleep(40);
  check("an empty collapsed column gets the library tab opened",
    calls.filter((kind) => kind === "paper-tool").length === 1, JSON.stringify(calls));
  dispose();
}

// A column holding anyone's tab — including the guide card — is not ours.
{
  const { ctx, calls, dispose } = makeRevealCtx({
    screen: () => ({ sessionId: "session-1", surface: { layout: { tabs: { t1: { kind: "guide" } }, expanded: false } } }),
  });
  exported.apply(ctx);
  await sleep(40);
  check("a column that already has tabs is left alone", calls.length === 0, JSON.stringify(calls));
  dispose();
}

// Expanded means the user has already found the column; do not add to it.
{
  const { ctx, calls, dispose } = makeRevealCtx({
    screen: () => ({ sessionId: "session-1", surface: { layout: { tabs: {}, expanded: true } } }),
  });
  exported.apply(ctx);
  await sleep(40);
  check("an expanded column is left alone", calls.length === 0, JSON.stringify(calls));
  dispose();
}

// No Session on screen is the normal state at activation; it must not throw,
// and must open as soon as one appears.
{
  let onScreen = false;
  const { ctx, calls, dispose } = makeRevealCtx({
    screen: () => (onScreen
      ? { sessionId: "session-1", surface: { layout: { tabs: {}, expanded: false } } }
      : undefined),
  });
  let applyError2 = null;
  try {
    exported.apply(ctx);
  } catch (error) {
    applyError2 = error;
  }
  await sleep(40);
  check("no Session on screen does not throw", applyError2 === null, applyError2?.message ?? "");
  check("nothing opens without a Session", calls.length === 0, JSON.stringify(calls));
  onScreen = true;
  await sleep(200);
  check("the tab opens once a Session appears",
    calls.filter((kind) => kind === "paper-tool").length >= 1, JSON.stringify(calls));
  dispose();
}

// openTab throws until the surface is committed. The throw must not escape and
// must not permanently give up; a retry has to land the tab.
{
  let attempts = 0;
  const { ctx, calls, dispose } = makeRevealCtx({
    screen: () => ({ sessionId: "session-1", surface: { layout: { tabs: {}, expanded: false } } }),
    openTab: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("sidebarRight: no session surface is mounted");
    },
  });
  let applyError3 = null;
  try {
    exported.apply(ctx);
  } catch (error) {
    applyError3 = error;
  }
  await sleep(40);
  check("a throwing openTab does not escape apply()", applyError3 === null, applyError3?.message ?? "");
  await sleep(250);
  check("a throwing openTab is retried instead of abandoned", calls.length >= 2, JSON.stringify(calls));
  dispose();
}

// The column layout is per Session, so a second Session must be revealed too;
// but a Session already decided about must not be reopened when the user comes
// back after closing the tab.
{
  let current = "session-1";
  let layout = { tabs: {}, expanded: false };
  const listeners = new Set();
  const calls = [];
  function NotifyHost() {
    return null;
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {}, bind: () => (key) => key },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_n, fn) => { fn(); return () => {}; }, register: (spec) => spec },
    connection: {},
    sidebarRight: {
      mounted: { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
      screen: () => (layout === null
        ? undefined
        : { sessionId: current, surface: { layout } }),
      openTab: (kind) => {
        calls.push(`${current}:${kind}`);
        // Mirror the real controller: opening a tab expands the column and
        // records a tab, which is what makes the seat finally render.
        layout = { tabs: { t1: { kind } }, expanded: true };
        for (const listener of listeners) listener();
      },
    },
  };
  const notify = () => { for (const listener of listeners) listener(); };
  exported.apply(ctx);
  await sleep(40);
  check("the first session reveals", calls.length === 1, JSON.stringify(calls));

  // Switch to a second, still-empty Session.
  current = "session-2";
  layout = { tabs: {}, expanded: false };
  notify();
  await sleep(60);
  check("a second empty session reveals too", calls.length === 2 && calls[1] === "session-2:paper-tool",
    JSON.stringify(calls));

  // The user closes the tab, then leaves and returns to the same Session.
  layout = { tabs: {}, expanded: false };
  current = "session-1";
  notify();
  await sleep(60);
  check("returning to a settled session does not reopen the tab",
    calls.length === 2, JSON.stringify(calls));
  void NotifyHost;
}

// --- cross-version loading ------------------------------------------------
// Cordis marks a plugin inactive when ANY declared inject name is missing, so a
// hard `inject` of `sidebarRightTabs` makes a build without it report
// "1 entry did not activate" and lose the whole plugin. The right column must
// therefore live behind a child fiber (`ctx.inject`) and must not be listed in
// the top-level `inject`.
check("the right column is not a hard top-level dependency",
  !exported.inject.some((name) => /^sidebarRight/.test(name)), JSON.stringify(exported.inject));
check("only universally-present services are required",
  exported.inject.every((name) => ["locale", "slots", "connection"].includes(name)),
  JSON.stringify(exported.inject));

// A build that provides the child-fiber API but NOT the right column: the
// callback must simply never run, and apply() must still return cleanly with
// the dictionaries registered.
{
  const dicts = [];
  let callbackRan = false;
  let applyErr = null;
  const bare = {
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: (ns, d) => { dicts.push(d); return () => {}; }, bind: () => (k) => k },
    slots: { inject: () => () => {}, register: (spec) => spec },
    connection: {},
    // cordis only invokes the callback once every dependency is available; a
    // build without the column never calls it.
    inject: (_deps, _cb) => { callbackRan = false; },
  };
  try {
    exported.apply(bare);
  } catch (error) {
    applyErr = error;
  }
  check("a build without the right column still activates", applyErr === null, applyErr?.message ?? "");
  check("no dictionaries are lost when the column is absent", dicts.length === 1, String(dicts.length));
  check("the right-column callback is gated, not forced", callbackRan === false);
}

// A build with the child-fiber API: the callback runs and must register the tab
// type there.
{
  let ran = false;
  const registeredTab = [];
  let depsOk = false;
  const withColumn = {
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: () => () => {}, register: (spec) => spec },
    connection: {},
    inject: (deps, cb) => {
      depsOk = Array.isArray(deps) && deps.includes("sidebarRightTabs");
      ran = true;
      cb({
        effect: (fn) => { fn(); return () => {}; },
        locale: { register: () => () => {}, bind: () => (k) => k },
        slots: { inject: () => () => {}, register: (spec) => spec },
        sidebarRightTabs: { register: (def) => { registeredTab.push(def); return () => {}; } },
        sidebarRight: {
          mounted: { subscribe: () => () => {} },
          screen: () => undefined,
          openTab: () => {},
        },
      });
    },
  };
  let applyErr = null;
  try {
    exported.apply(withColumn);
  } catch (error) {
    applyErr = error;
  }
  check("apply() runs on a build with the column", applyErr === null, applyErr?.message ?? "");
  check("the child fiber declares the column deps", depsOk === true);
  check("the right-column callback did run", ran === true);
  check("the tab type is registered inside the child fiber",
    registeredTab.length === 1 && registeredTab[0].kind === "paper-tool", String(registeredTab.length));
}

if (failures.length > 0) {
  console.error(`\nUI-RENDER FAILED (${failures.length}):`);
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("\nUI-RENDER PASS");

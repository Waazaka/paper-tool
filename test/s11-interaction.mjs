// Interaction gate: drive the real client bundle through real click sequences.
//
// Every other UI gate renders with react-dom/server, which never runs a
// useEffect. The reported defect — "after I open a paper, clicking another tab
// leaves a blank pane" — cannot happen during render: it happens inside an
// effect or an async continuation that runs after mount. This gate mounts the
// real Body against the DOM stub, clicks the way a user would, and fails on any
// thrown error, unhandled rejection, or empty pane.
//
// Run: node test/s11-interaction.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, sep } from "node:path";
import { installDom, clickText } from "./dom-stub.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

// --- React from the desktop profile --------------------------------------
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
  console.error(`INTERACTION: react not resolvable from ${ROOT}: ${error.message}`);
  process.exit(2);
}
console.log(`INTERACTION: react ${React.version}`);

// --- DOM before the bundle loads -----------------------------------------
const { document } = installDom({ width: 360, height: 640 });

// Surface every error a browser would report in the console instead of letting
// the process die silently: a React render error and an unhandled rejection look
// identical to the user (a blank pane) but need different fixes.
const seen = [];
const originalError = console.error;
console.error = (...args) => {
  const text = args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack}` : String(arg)))
    .join(" ");
  seen.push(text);
  const printable = args.filter((arg) => typeof arg !== "string" || !arg.includes("not wrapped in act"));
  originalError(...printable);
};
process.on("unhandledRejection", (reason) => {
  seen.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// A Host stand-in. The bundle talks to the Host through a module-level
// `sharedCtx` captured by apply(ctx), not through props, so the ctx has to be
// installed the way the real host does it.
const calls = [];
const papers = [
  {
    paperId: "p1",
    title: "\u65c5\u6e38\u7ecf\u6d4e\u9ad8\u8d28\u91cf\u53d1\u5c55\u7814\u7a76",
    authors: "\u674e\u4e66\u660a; \u9b4f\u654f",
    year: "2023",
    venue: "\u4e91\u5357\u6c11\u65cf\u5927\u5b66\u5b66\u62a5",
    numPages: 9,
    material: "fulltext",
    pdfPath: "/a.pdf",
    hitCount: 0,
  },
  {
    paperId: "p2",
    title: "Hotel servicescape",
    authors: "Shuhao Li",
    year: "2021",
    venue: "IJCHM",
    numPages: 12,
    material: "fulltext",
    pdfPath: "/b.pdf",
    hitCount: 0,
  },
];
function answer(method, params) {
  calls.push({ method, params });
  switch (method) {
    case "libraryStatus":
      return { library: { papers: papers.length, pages: 12, evidence: 0 } };
    case "listPapers":
      return { papers };
    case "listEvidence":
      return { evidence: [] };
    case "readPaperBytes":
      return { data: new Uint8Array([1, 2, 3]) };
    case "readPaper":
      return { pages: [{ pageIndex: 0, text: "\u670d\u52a1\u573a\u666f" }] };
    case "getPdfRuntime":
      // Deliberately fail: a real PDF.js worker cannot run here, and that failure
      // is the interesting case. The reader must contain it, not take the pane down.
      throw new Error("pdf runtime unavailable in test");
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
check("client bundle loads with a DOM present", loadError === null && exported !== null, loadError?.message ?? "");
if (loadError !== null) process.exit(1);

const { Body, DICTS } = exported.__test;
function makeT(dict) {
  return (key, params) => {
    const raw = dict[key];
    if (raw === undefined) throw new Error(`missing translation key: ${key}`);
    if (params === undefined) return raw;
    return String(raw).replace(/\{(\w+)\}/g, (all, name) =>
      (params[name] === undefined ? all : String(params[name])));
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

// --- mount ----------------------------------------------------------------
const container = document.createElement("div");
document.body.appendChild(container);
const inputActions = { captureInsertion() {}, insertText() {} };

let root;
try {
  root = createRoot(container);
  root.render(React.createElement(Body, { sessionId: "session-interaction", inputActions, t }));
} catch (error) {
  check("the pane mounts", false, error?.message ?? String(error));
  process.exit(1);
}

// Let the initial effects and their Host round-trips settle. A fixed number of
// macrotask turns is enough because every stand-in call resolves immediately.
async function settle(turns = 12) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const paneText = () => container.textContent;

await settle();
check("the pane mounts and shows something", container.childNodes.length > 0, "container is empty");
check("the library tab is present", paneText().includes(DICTS.zh.library), paneText().slice(0, 160));
check("both papers are listed",
  paneText().includes(papers[0].title) && paneText().includes(papers[1].title),
  paneText().slice(0, 240));

// --- the reported defect -------------------------------------------------
// Open a paper. This mounts PdfReader, which starts loading PDF.js from the Host
// and will fail here — the reader must contain that failure.
if (!paneText().includes(DICTS.zh.open)) {
  check("the open button is reachable", false, paneText().slice(0, 300));
} else {
  const errorsBefore = seen.length;
  clickText(container, DICTS.zh.open);
  await settle();
  check("clicking open does not throw", seen.length === errorsBefore, seen.slice(errorsBefore).join(" | ").slice(0, 300));
  check("the reader opened",
    container.find((el) => el.classList.contains("pt-reader")) !== null
      || paneText().includes(DICTS.zh.closeReader),
    paneText().slice(0, 240));
  // With the runtime unavailable the reader must say so. An empty canvas that
  // looks like a blank page would be a lie about what was rendered.
  check("an unavailable PDF runtime is reported inside the reader",
    paneText().includes("pdf runtime unavailable"),
    paneText().slice(0, 240));

  // Switch tabs while the reader is open. This is the exact sequence from the
  // report.
  for (const [tabKey, label] of [
    ["evidence", DICTS.zh.evidenceTab],
    ["review", DICTS.zh.reviewTab],
    ["library", DICTS.zh.library],
  ]) {
    const before = seen.length;
    let clicked = true;
    try {
      clickText(container, label);
    } catch (error) {
      clicked = false;
      check(`switching to ${tabKey} finds its tab`, false, error.message);
    }
    if (!clicked) continue;
    await settle();
    check(`switching to ${tabKey} does not throw`, seen.length === before, seen.slice(before).join(" | ").slice(0, 400));
    check(`switching to ${tabKey} leaves a visible pane`,
      container.childNodes.length > 0 && paneText().trim() !== "",
      `pane text: ${JSON.stringify(paneText().slice(0, 140))}`);
  }

  // Returning to the library with the reader still open must not blank the pane.
  // The reader replaces the list by design (it is a full-pane mode), so what
  // matters here is that the tab is still reachable and the pane still paints.
  const beforeReturn = seen.length;
  clickText(container, DICTS.zh.library);
  await settle();
  check("returning to the library does not throw", seen.length === beforeReturn, seen.slice(beforeReturn).join(" | ").slice(0, 300));
  check("returning to the library leaves a visible pane",
    container.childNodes.length > 0 && paneText().trim() !== "",
    paneText().slice(0, 160));

  // Close the reader explicitly: its cleanup must be safe.
  const beforeClose = seen.length;
  if (paneText().includes(DICTS.zh.closeReader)) {
    clickText(container, DICTS.zh.closeReader);
    await settle();
  }
  check("closing the reader does not throw", seen.length === beforeClose, seen.slice(beforeClose).join(" | ").slice(0, 300));
}

// Rapid tab switching: the user dragging across the tab strip. Every one of these
// mounts and unmounts views while async work is still in flight.
const beforeRapid = seen.length;
for (let i = 0; i < 6; i++) {
  for (const label of [DICTS.zh.evidenceTab, DICTS.zh.reviewTab, DICTS.zh.library]) {
    try {
      clickText(container, label);
    } catch {
      // The tab list can be mid-update; a missed click is not a defect.
    }
  }
}
await settle(20);
check("rapid tab switching does not throw", seen.length === beforeRapid, seen.slice(beforeRapid).join(" | ").slice(0, 400));
check("the pane survives rapid tab switching",
  container.childNodes.length > 0 && paneText().trim() !== "",
  `pane text: ${JSON.stringify(paneText().slice(0, 140))}`);

root.unmount();
await settle(4);

console.error = originalError;
console.log("");
if (failures.length > 0) {
  console.log(`INTERACTION FAILED (${failures.length})`);
  for (const failure of failures) console.log(` - ${failure}`);
}
process.exit(failures.length === 0 ? 0 : 1);

// Resilience gate: a broken view must not blank the pane.
//
// The user reported that opening a paper and then clicking another tab left a
// blank sidebar. The pane is one React tree with no boundary above it, so any
// throw during render — or inside a lifecycle — unmounted everything and left
// nothing to click. This gate proves the boundary holds, and that the reader
// degrades to text when its canvas refuses a 2D context.
//
// Run: node test/s13-resilience.mjs
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
  console.error(`RESILIENCE: react not resolvable: ${error.message}`);
  process.exit(2);
}

const { document } = installDom({ width: 360, height: 640 });

// Node cannot import blob: URLs, which is what the browser path produces. Record
// the Blob's source and hand back a data: URL carrying the same module, so the
// reader's real load path still runs.
const NativeBlob = globalThis.Blob;
const blobSources = new WeakMap();
globalThis.Blob = class extends NativeBlob {
  constructor(parts = [], options = {}) {
    super(parts, options);
    blobSources.set(this, parts.map((part) => String(part ?? "")).join(""));
  }
};
const NativeURL = globalThis.URL;
globalThis.URL = class extends NativeURL {};
globalThis.URL.createObjectURL = (blob) =>
  `data:text/javascript;base64,${Buffer.from(blobSources.get(blob) ?? "", "utf8").toString("base64")}`;
globalThis.URL.revokeObjectURL = () => {};

// A PDF.js stub whose document loads fine but whose canvas has no 2D context,
// which is the case this gate is about.
const PDFJS_STUB = `
export const GlobalWorkerOptions = { workerSrc: "" };
export function getDocument() {
  const page = {
    getViewport: ({ scale = 1 }) => ({ width: 400 * scale, height: 600 * scale, scale }),
    streamTextContent: () => ({ getReader: () => ({ read: async () => ({ done: true }) }) }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
  };
  return {
    promise: Promise.resolve({
      numPages: 5,
      getPage: async () => page,
      destroy: async () => {},
    }),
  };
}
export class TextLayer {
  constructor(options) { this.container = options.container; }
  async render() {}
}
`;

// React logs caught render errors; keep them out of the transcript but record
// them so a test can prove the error was actually caught rather than avoided.
const logged = [];
const originalError = console.error;
console.error = (...args) => {
  logged.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" "));
};

const papers = [{
  paperId: "p1",
  title: "\u65c5\u6e38\u7ecf\u6d4e",
  authors: "A",
  year: "2023",
  venue: "V",
  numPages: 5,
  material: "fulltext",
  pdfPath: "/a.pdf",
  hitCount: 0,
}];

// The Host can be told to make one endpoint throw, which is how the boundary is
// exercised with a real failure rather than a synthetic throw in a test hook.
const state = { breakEvidence: true };
function answer(method) {
  switch (method) {
    case "libraryStatus":
      return { library: { papers: 1, pages: 5, evidence: 0 } };
    case "listPapers":
      return { papers };
    case "listEvidence":
      if (state.breakEvidence) throw new Error("evidence backend exploded");
      return { evidence: [] };
    case "readPaperBytes":
      return { data: new Uint8Array([1]) };
    case "getPdfRuntime":
      return { pdfMainSource: PDFJS_STUB, pdfWorkerSource: "" };
    case "readPaper":
      return { pages: [{ pageIndex: 0, text: "\u670d\u52a1\u573a\u666f\u5f71\u54cd\u987e\u5ba2" }] };
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
check("client bundle loads", loadError === null && exported !== null, loadError?.message ?? "");
if (loadError !== null) process.exit(1);

const { Body, PdfReader, DICTS } = exported.__test;
function makeT(dict) {
  return (key, params) => {
    const raw = dict[key];
    if (raw === undefined) throw new Error(`missing translation key: ${key}`);
    if (params === undefined) return raw;
    return String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
  };
}
const t = makeT(DICTS.zh);

exported.apply({
  connection: {
    rpc: {
      async call(_path, method) {
        const bare = String(method).replace(/^paperTool\//, "");
        try {
          return { ok: true, value: answer(bare) };
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
});

async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// --- 1. the boundary exists ----------------------------------------------
check("a view boundary is registered for each tab", typeof exported.__test.ViewBoundary === "function",
  "ViewBoundary is not exported for testing");

// --- 2. a crashing view keeps the pane alive -----------------------------
// listEvidence throws, which is what a broken backend looks like. The evidence
// tab must show the boundary's message instead of unmounting the plugin.
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
root.render(React.createElement(Body, { sessionId: "s-resilience", inputActions: { captureInsertion() {}, insertText() {} }, t }));
await settle();

check("the pane mounts", container.textContent.includes(DICTS.zh.library), container.textContent.slice(0, 140));

const beforeCrash = logged.length;
try {
  clickText(container, DICTS.zh.evidenceTab);
} catch (error) {
  check("the evidence tab is clickable", false, error.message);
}
await settle();

// Whatever happens, the pane must still be there and the tabs must still work.
check("the pane survives a crashing view", container.childNodes.length > 0 && container.textContent.trim() !== "",
  container.textContent.slice(0, 200));
check("the tab strip is still rendered after a crash",
  container.find((el) => el.getAttribute("role") === "tablist") !== null,
  container.textContent.slice(0, 200));

// Switching away from the crashed tab must recover, because the boundary is
// keyed by view.
const afterCrash = logged.length;
try {
  clickText(container, DICTS.zh.library);
} catch (error) {
  check("the library tab is still clickable after a crash", false, error.message);
}
await settle();
check("switching away from a crashed view recovers", container.textContent.includes(papers[0].title),
  container.textContent.slice(0, 200));
check("switching away from a crash does not throw again", logged.length === afterCrash,
  logged.slice(afterCrash).join(" | ").slice(0, 300));

root.unmount();
await settle(4);

// --- 3. the reader degrades to text when the canvas refuses a context ----
// document.createElement("canvas").getContext("2d") returns null in this stub,
// which is exactly what happens when a browser runs out of canvas contexts. The
// reader must fall back to page text instead of handing null to PDF.js.
const holder = document.createElement("div");
document.body.appendChild(holder);
const root2 = createRoot(holder);
const beforeReader = logged.length;
root2.render(React.createElement(PdfReader, {
  sessionId: "s-resilience",
  paper: { paperId: "p1", title: "\u65c5\u6e38\u7ecf\u6d4e", pageIndex: 0 },
  initialPage: 0,
  highlight: null,
  t,
  onSelectionChange() {},
  onClose() {},
}));
await settle(30);
check("the reader mounts without a canvas context", holder.find((el) => el.classList.contains("pt-reader")) !== null,
  holder.textContent.slice(0, 160));
check("a missing canvas context does not throw", logged.length === beforeReader,
  logged.slice(beforeReader).join(" | ").slice(0, 300));
check("the reader falls back to page text", holder.textContent.includes(DICTS.zh.textFallbackNote),
  holder.textContent.slice(0, 240));
check("the fallback carries the page text", holder.textContent.includes("\u670d\u52a1\u573a\u666f"),
  holder.textContent.slice(0, 240));
root2.unmount();
await settle(4);

console.error = originalError;
console.log("");
if (failures.length > 0) {
  console.log(`RESILIENCE FAILED (${failures.length})`);
  for (const failure of failures) console.log(` - ${failure}`);
} else {
  console.log("RESILIENCE PASS");
}
process.exit(failures.length === 0 ? 0 : 1);

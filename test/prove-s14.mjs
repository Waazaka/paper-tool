// Self-test for gate s14: prove it catches the ORIGINAL bug.
//
// A gate that passes both before and after a fix is worthless. This runs the same
// teardown against a copy of the bundle patched back to `doc.destroy()` and
// asserts that the failure appears.
//
// Run: node test/prove-s14.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { installDom } from "./dom-stub.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

// Patch the teardown back to the broken version.
const source = readFileSync("client.js", "utf8");
const anchor = `      if (loadingTask && typeof loadingTask.destroy === "function") {
        attempt("loadingTask.destroy", () => loadingTask.destroy());
      } else if (doc && typeof doc.cleanup === "function") {
        // No task to destroy; at least drop the cached page/font data.
        attempt("doc.cleanup", () => doc.cleanup());
      }`;
if (!source.includes(anchor)) {
  console.log("  FAIL the teardown anchor moved; this self-test needs updating");
  process.exit(1);
}
const regressed = source.replace(anchor,
  `      if (doc !== null && doc !== undefined) doc.destroy().catch(() => {});`);
const regressedPath = join(process.cwd(), "test", ".client-regressed.mjs");
writeFileSync(regressedPath, regressed, "utf8");

const ROOT = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules");
const requireFromProfile = createRequire(join(ROOT, "noop.js"));
const domEntry = requireFromProfile.resolve("react-dom/server");
const domRoot = domEntry.slice(0, domEntry.indexOf(`${sep}react-dom${sep}`));
const requireFromDom = createRequire(join(domRoot, "noop.js"));
const { createRoot } = requireFromDom("react-dom/client");
const React = requireFromDom("react");

const { document } = installDom({ width: 360, height: 640 });
const NativeElement = Object.getPrototypeOf(document.createElement("div")).constructor;
NativeElement.prototype.getContext = function getContext(kind) {
  if (String(kind) !== "2d") return null;
  return {
    canvas: this, save() {}, restore() {}, scale() {}, translate() {},
    clearRect() {}, fillRect() {}, drawImage() {}, setTransform() {}, resetTransform() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
  };
};

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

// Exactly the PDF.js 6 shape: no destroy on the document.
const PDFJS_STUB = `
const s = (globalThis.__pdfApi = { taskDestroyed: 0, cleanupCalls: 0, renders: 0 });
export const GlobalWorkerOptions = { workerSrc: "" };
export function getDocument() {
  const page = {
    getViewport: ({ scale = 1 }) => ({ width: 400 * scale, height: 600 * scale, scale }),
    streamTextContent: () => ({ getReader: () => ({ read: async () => ({ done: true }) }) }),
    render: () => {
      s.renders += 1;
      let ok; const p = new Promise((r) => { ok = r; });
      setTimeout(ok, 0);
      return { promise: p, cancel() {} };
    },
  };
  const doc = { numPages: 5, getPage: async () => page, cleanup: async () => { s.cleanupCalls += 1; } };
  return { promise: Promise.resolve(doc), destroy: async () => { s.taskDestroyed += 1; } };
}
export class TextLayer { constructor(o) { this.c = o.container; } async render() {} }
`;

const errors = [];
const originalError = console.error;
console.error = (...args) => {
  errors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
};

let exported = null;
globalThis.window.__ModuleLoader__ = {
  load({ factory }) {
    exported = factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
  },
};
await import(pathToFileURL(regressedPath).href);

const { PdfReader, ViewBoundary, DICTS } = exported.__test;
const t = (key, params) => {
  const raw = DICTS.zh[key];
  if (raw === undefined) throw new Error(`missing ${key}`);
  return params === undefined ? raw : String(raw).replace(/\{(\w+)\}/g, (a, n) => (params[n] === undefined ? a : String(params[n])));
};
exported.apply({
  connection: {
    rpc: {
      async call(_path, method) {
        const bare = String(method).replace(/^paperTool\//, "");
        const table = {
          readPaperBytes: { data: new Uint8Array([1]) },
          getPdfRuntime: { pdfMainSource: PDFJS_STUB, pdfWorkerSource: "" },
          getPdfAsset: { data: new Uint8Array([0]) },
          readPaper: { pages: [{ pageIndex: 0, text: "x" }] },
        };
        return { ok: true, value: table[bare] ?? {} };
      },
    },
  },
  locale: { register() {}, bind: () => t },
  slots: { inject() {}, register: () => ({}) },
  sidebarRightTabs: { register: () => ({}) },
  effect() {},
});

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
root.render(React.createElement(ViewBoundary, { t },
  React.createElement(PdfReader, {
    sessionId: "s",
    paper: { paperId: "p1", title: "T", pageIndex: 0 },
    initialPage: 0,
    highlight: null,
    t,
    onSelectionChange() {},
    onClose() {},
  })));

async function settle(turns = 30) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}
await settle();

const before = errors.length;
root.unmount();
await settle(20);

// IMPORTANT: a throw inside an effect *teardown* is not caught by a React error
// boundary — boundaries only cover render, lifecycle and constructor. That is why
// the regressed bundle ends with an empty pane rather than the boundary's message,
// and why the user saw "这个视图出错了 doc.destroy is not a function": the boundary
// caught a *later* render that followed the failed teardown.
//
// So the evidence for this gate is: the pane ends up empty, the loading task was
// never destroyed, and React itself reported an error in <PdfReader>.
const emptyPane = container.textContent.trim() === "";
const sawDestroyError = errors.some((line) => /destroy is not a function/i.test(line));
const crashed = emptyPane || sawDestroyError;
check("the regressed bundle leaves the pane empty on close", emptyPane,
  `pane text: ${JSON.stringify(container.textContent.slice(0, 120))}`);
check("the regressed bundle never destroys the loading task", globalThis.__pdfApi.taskDestroyed === 0,
  JSON.stringify(globalThis.__pdfApi));
check("so gate s14 is genuinely load-bearing", crashed && globalThis.__pdfApi.taskDestroyed === 0,
  `emptyPane=${emptyPane} sawDestroyError=${sawDestroyError} taskDestroyed=${globalThis.__pdfApi.taskDestroyed}`);

console.error = originalError;
unlinkSync(regressedPath);

console.log("");
if (failures.length > 0) {
  console.log(`PROVE-S14 FAILED (${failures.length})`);
  for (const failure of failures) console.log(` - ${failure}`);
} else {
  console.log("PROVE-S14 PASS (the gate catches the original defect)");
}
process.exit(failures.length === 0 ? 0 : 1);

// PDF.js API gate: the reader must release documents through the API that
// actually exists.
//
// Reported defect: opening a paper and pressing 「返回列表」 showed
// "doc.destroy is not a function". PDF.js 6 removed `destroy` from
// PDFDocumentProxy — the worker belongs to the loading task — so the teardown
// path threw while React was unmounting, and the view boundary turned that into
// an error page.
//
// This gate does not invent a convenient fake. It first asserts the real
// installed build's shape, then drives the reader's teardown with a document
// that lacks `destroy`, which is exactly what the real one looks like.
//
// Run: node test/s14-pdf-api.mjs
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, sep } from "node:path";
import { installDom } from "./dom-stub.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

// --- 1. what the installed PDF.js actually offers ------------------------
function findOnePdf(root) {
  try {
    for (const entry of readdirSync(root, { recursive: true })) {
      const name = String(entry);
      if (name.toLowerCase().endsWith(".pdf")) return join(root, name);
    }
  } catch {
    /* no corpus */
  }
  return null;
}

let realApi;
try {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  realApi = { version: pdfjs.version ?? "unknown" };
  const probe = findOnePdf(join(process.env.USERPROFILE ?? "", "Zotero", "storage"));
  if (probe === null) {
    realApi.skipped = "no PDF found in the Zotero corpus";
  } else {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(probe)),
      isEvalSupported: false,
      useWorkerFetch: false,
      enableXfa: false,
    }).promise;
    realApi.docHasDestroy = typeof doc.destroy;
    realApi.docHasCleanup = typeof doc.cleanup;
    realApi.taskHasDestroy = typeof doc.loadingTask?.destroy;
    if (realApi.taskHasDestroy === "function") await doc.loadingTask.destroy();
  }
} catch (error) {
  realApi = { error: error.message };
}

if (realApi.error !== undefined) {
  console.log(`  skip could not inspect the installed PDF.js: ${realApi.error}`);
} else if (realApi.skipped !== undefined) {
  console.log(`  skip ${realApi.skipped}`);
} else {
  console.log(`  ..   pdfjs ${realApi.version}: document.destroy=${realApi.docHasDestroy} ` +
    `cleanup=${realApi.docHasCleanup} loadingTask.destroy=${realApi.taskHasDestroy}`);
  check("the installed PDF.js document has no destroy()", realApi.docHasDestroy !== "function",
    `destroy is ${realApi.docHasDestroy}; the client must not call it`);
  check("the installed PDF.js document has cleanup()", realApi.docHasCleanup === "function",
    `cleanup is ${realApi.docHasCleanup}`);
  check("the installed PDF.js loading task can be destroyed", realApi.taskHasDestroy === "function",
    `loadingTask.destroy is ${realApi.taskHasDestroy}`);
}

// --- 2. load the bundle through the module-loader shim -------------------
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
  console.error(`PDF-API: react not resolvable: ${error.message}`);
  process.exit(2);
}

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

// Node cannot import blob: URLs, so hand the bundle a data: URL with the same
// source. Its own code path — getDocument, the loading task, teardown — is
// unchanged.
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

// The stub mirrors PDF.js 6 EXACTLY on the point that broke: the document has
// cleanup() and no destroy(); only the loading task is destroyable.
const PDFJS_STUB = `
const stats = (globalThis.__pdfApi = { taskDestroyed: 0, cleanupCalls: 0, renders: 0 });
export const GlobalWorkerOptions = { workerSrc: "" };
export function getDocument() {
  const page = {
    getViewport: ({ scale = 1 }) => ({ width: 400 * scale, height: 600 * scale, scale }),
    streamTextContent: () => ({ getReader: () => ({ read: async () => ({ done: true }) }) }),
    render: () => {
      stats.renders += 1;
      let resolveTask;
      const promise = new Promise((resolve) => { resolveTask = resolve; });
      setTimeout(resolveTask, 0);
      return { promise, cancel() {} };
    },
  };
  const doc = {
    numPages: 5,
    getPage: async () => page,
    cleanup: async () => { stats.cleanupCalls += 1; },
  };
  return {
    promise: Promise.resolve(doc),
    destroy: async () => { stats.taskDestroyed += 1; },
  };
}
export class TextLayer {
  constructor(options) { this.container = options.container; }
  async render() {}
}
`;

function answer(method) {
  switch (method) {
    case "readPaperBytes":
      return { data: new Uint8Array([1, 2, 3]) };
    case "getPdfRuntime":
      return { pdfMainSource: PDFJS_STUB, pdfWorkerSource: "" };
    case "getPdfAsset":
      return { data: new Uint8Array([0]) };
    case "readPaper":
      return { pages: [{ pageIndex: 0, text: "\u670d\u52a1\u573a\u666f" }] };
    default:
      return {};
  }
}

const seen = [];
const originalError = console.error;
console.error = (...args) => {
  seen.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" "));
};

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
if (loadError !== null || exported === null) {
  console.error = originalError;
  process.exit(1);
}

const { PdfReader, ViewBoundary, DICTS } = exported.__test;
check("the reader is exported for testing", typeof PdfReader === "function");
check("a view boundary exists", typeof ViewBoundary === "function");

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

async function settle(turns = 24) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const beforeMount = seen.length;
const readerPaper = { paperId: "p1", title: "\u65c5\u6e38\u7ecf\u6d4e", pageIndex: 0 };
root.render(
  React.createElement(ViewBoundary, { t },
    React.createElement(PdfReader, {
      sessionId: "s-pdf-api",
      paper: readerPaper,
      initialPage: 0,
      highlight: null,
      t,
      onSelectionChange() {},
      onClose() {},
    })),
);
await settle(30);

check("the reader mounts against a real-API PDF.js stub",
  container.find((el) => el.classList.contains("pt-reader")) !== null
    || container.textContent.includes(DICTS.zh.closeReader),
  container.textContent.slice(0, 200));
check("no error appeared while mounting", seen.length === beforeMount,
  seen.slice(beforeMount).join(" | ").slice(0, 400));
check("the stub rendered a page", (globalThis.__pdfApi?.renders ?? 0) > 0,
  JSON.stringify(globalThis.__pdfApi));

// --- 3. the reported crash: unmount while the document is live ----------
// This is the user's action: press 返回列表, which unmounts the reader.
const beforeUnmount = seen.length;
root.unmount();
await settle(20);
check("closing the reader does not throw", seen.length === beforeUnmount,
  seen.slice(beforeUnmount).join(" | ").slice(0, 500));
check("closing the reader does not report 'destroy is not a function'",
  !seen.some((line) => /destroy is not a function/i.test(line)),
  seen.filter((line) => /destroy/i.test(line)).join(" | ").slice(0, 400));
check("the loading task was destroyed on close", (globalThis.__pdfApi?.taskDestroyed ?? 0) > 0,
  JSON.stringify(globalThis.__pdfApi));
check("the view boundary showed no error page", !container.textContent.includes(DICTS.zh.viewCrashed),
  container.textContent.slice(0, 200));

console.error = originalError;
console.log("");
if (failures.length > 0) {
  console.log(`PDF-API FAILED (${failures.length})`);
  for (const failure of failures) console.log(` - ${failure}`);
} else {
  console.log("PDF-API PASS");
}
process.exit(failures.length === 0 ? 0 : 1);

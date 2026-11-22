// Mount the real client bundle and drive directory import, drag-and-drop, and the
// watch toggle (PT-017).
//
// Why a separate mount gate. Thirteen source-text assertions in s32 passed while
// eight deliberate mutations went undetected, and every one of the misses was the
// same shape: the string was still in client.js but no longer reached the DOM.
//
//   - `webkitdirectory: ""` was renamed to a dead key — still matches a grep for
//     "webkitdirectory", no directory input rendered.
//   - `onDrop: onPanelDrop` was renamed — the root still had a `drop` prop name.
//   - `if (entry.isDirectory)` was disabled — the recursion code still existed.
//   - `readEntries` resolved after one page — the call was still there.
//   - the drop veil was made unreachable — the CSS and the element remained.
//   - `dragover` stopped calling preventDefault — the handler was still bound.
//
// So this file mounts the shipped Body against a DOM stub, simulates a real drop
// with a fake DataTransfer, and asserts on what the component actually sent.
//
// Run: node test/s32b-import-mount.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, sep } from "node:path";
import { readFileSync } from "node:fs";
import { installDom, clickText } from "./dom-stub.mjs";

const failures = [];
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === "" ? "" : " -> " + detail));
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
  console.error(`IMPORT-MOUNT: react not resolvable from ${ROOT}: ${error.message}`);
  process.exit(2);
}

const { document, window } = installDom({ width: 360, height: 720 });

const seenErrors = [];
const realConsoleError = console.error.bind(console);
console.error = (...args) => {
  const text = args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" ");
  seenErrors.push(text);
};
process.on("unhandledRejection", (reason) => {
  seenErrors.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// --- the bundle ----------------------------------------------------------
let exported = null;
globalThis.window.__ModuleLoader__ = {
  load({ factory }) {
    exported = factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
  },
};
await import(pathToFileURL(join(process.cwd(), "client.js")).href);
if (exported === null) {
  console.error("IMPORT-MOUNT: client.js did not register a module");
  process.exit(2);
}
const { Body, DICTS } = exported.__test;
const zh = DICTS.zh;
const t = (key, params) => {
  const raw = zh[key];
  if (raw === undefined) return key;
  return params === undefined ? raw : String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
};

// --- Host stand-in -------------------------------------------------------
// The limits deliberately differ from the client fallback so "read from status"
// is observable: a client using its own 32 would import 32, this one imports 5.
const HOST_LIMIT = 5;
const calls = [];
// Every call ever made, for assertions about mount-time behaviour: `calls` is
// cleared between sections, so a mount-time probe would otherwise be invisible.
const allCalls = [];
// Two filename-level rows the Host reports for a body it could not make fully
// searchable. They ride along on the *first* import only: later sections count
// the rows they sent, and a fixed pair on every call would change their totals.
const FIRST_IMPORT_FIXTURES = [
  { filename: "meta-only.pdf", material: "metadata", ocr: { skipped: true, reason: "no usable text layer" } },
  { filename: "ocr-partial.pdf", material: "ocr", ocr: { pagesRecognised: 2, pagesFailed: 1 } },
];
let importCallCount = 0;
function answer(method, params) {
  // The RPC envelope puts the arguments one level down, under `args`: reading
  // `params.input` directly finds nothing and made every assertion see an empty
  // payload while the real call was perfectly fine.
  const record = { method, params: params ?? {}, input: params?.input ?? params?.args?.input ?? params?.args ?? {} };
  calls.push(record);
  allCalls.push(record);
  switch (method) {
    case "status":
      return {
        library: { papers: 0, pages: 0, evidence: 0 },
        limits: { maxImportFiles: HOST_LIMIT, maxPdfBytes: 64 * 1024 * 1024 },
      };
    case "listPapers":
      return { papers: [], library: { papers: 0, pages: 0, evidence: 0 }, paging: { offset: 0, limit_returned: 0, total: 0, hasMore: false } };
    case "listEvidence":
      return { evidence: [], paging: { offset: 0, limit_returned: 0, total: 0, hasMore: false, anchoredTotal: 0, allTotal: 0 } };
    case "listAnnotations":
      return { annotations: [] };
    case "importPdf": {
      // `record.input` is the already-flattened payload: the envelope hides the
      // files under `args.input`, so reading `params.input` here would find nothing
      // and return zero imported rows while the request itself looked fine.
      const files = record.input?.files ?? [];
      importCallCount += 1;
      // Name the fixtures after the files that were actually sent, so a reader can
      // tell the two rows apart; the count still comes from the request.
      const fixtures = importCallCount === 1
        ? FIRST_IMPORT_FIXTURES.map((fixture, index) => ({ ...fixture, filename: files[index]?.name ?? fixture.filename }))
        : [];
      const byFilename = new Map(fixtures.map((fixture) => [fixture.filename, fixture]));
      const imported = files.map((file) => {
        const fixture = byFilename.get(file.name);
        if (fixture === undefined) return { filename: file.name };
        byFilename.delete(file.name);
        return { ...fixture, filename: file.name };
      });
      // A fixture whose file never arrived still has to be reported, or the second
      // coverage line would silently disappear from a one-file request.
      return { imported: [...imported, ...byFilename.values()], duplicates: [], failed: [], library: { papers: files.length }, remaining: 0, limit: HOST_LIMIT };
    }
    case "watchStatus":
      return { watching: false, dir: null, imported: 0, duplicates: 0, failed: 0, lastError: null, pending: 0 };
    case "watchStart":
      return { watching: true, dir: params?.input?.dir ?? null, imported: 0, duplicates: 0, failed: 0, lastError: null, pending: 0 };
    case "watchStop":
      return { watching: false, dir: null };
    default:
      return {};
  }
}
const ctx = {
  connection: { rpc: { async call(_path, method, options) {
    const bare = String(method).replace(/^paperTool\//, "");
    return { ok: true, value: answer(bare, options) };
  } } },
  locale: { register() {}, bind: () => t },
  slots: { inject() {}, register: () => ({}) },
  sidebarRightTabs: { register: () => ({}) },
  effect() {},
};
exported.apply(ctx);

// --- helpers -------------------------------------------------------------
const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
const settle = async (turns = 16) => { for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function buttons() {
  return [...host.querySelectorAll("button")];
}
function findButton(label) {
  return buttons().find((button) => button.textContent.trim() === label)
    ?? buttons().find((button) => button.textContent.trim().startsWith(label));
}
function makePdfFile(name, size = 1024) {
  // The client only reads `name` and `size` before handing bytes to the RPC, and
  // arrayBuffer() has to exist because the real path calls it.
  return {
    name,
    size,
    arrayBuffer: async () => new Uint8Array(size).fill(37).buffer,
  };
}
function makeDataTransfer(files, entries = []) {
  // A realistic-enough DataTransfer: `types` must contain "Files" or the handlers
  // ignore the drag entirely (that guard is itself a requirement).
  return {
    types: ["Files"],
    files,
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
    dropEffect: "none",
  };
}
function fireDragEvent(node, type, dataTransfer) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  node.dispatchEvent(event);
  return event;
}

root.render(React.createElement(Body, {
  sessionId: "pt017",
  inputActions: { captureInsertion() {}, insertText() {} },
  t,
}));
await settle();

// --- 1. the panel offers a folder picker --------------------------------
{
  const folderButton = findButton(zh.importFolder);
  check("the panel has a folder-import button", folderButton !== undefined,
    JSON.stringify(buttons().map((b) => b.textContent.trim())));

  const inputs = [...host.querySelectorAll("input")];
  const dirInput = inputs.find((input) => input.getAttribute("aria-label") === zh.importFolder);
  check("a directory input exists", dirInput !== undefined,
    JSON.stringify(inputs.map((i) => i.getAttribute("aria-label"))));
  // The attribute is what makes the browser's picker return a folder tree.
  check("the directory input is marked webkitdirectory",
    dirInput !== undefined && dirInput.getAttribute("webkitdirectory") !== null,
    dirInput === undefined ? "no input" : JSON.stringify(dirInput.getAttribute("webkitdirectory")));
  // And it must still accept multiple files, or a folder yields one PDF.
  // dom-stub reflects boolean DOM props as properties (`multiple`), not always as
  // attributes, so accept either: what matters is that the input accepts many files.
  const multipleValue = dirInput?.multiple ?? dirInput?.getAttribute("multiple");
  check("directory import keeps multiple selection",
    multipleValue === true || (multipleValue !== null && multipleValue !== undefined && multipleValue !== "false"),
    JSON.stringify(multipleValue));
}

// --- 2. the cap comes from status, not from the client ----------------
{
  // The Host says 5. If the client used its own 32, all 12 would be sent.
  const files = Array.from({ length: 12 }, (_, index) => makePdfFile(`paper-${index}.pdf`));
  const fileInput = [...host.querySelectorAll("input")]
    .find((input) => input.getAttribute("aria-label") === zh.import);
  check("a file input exists", fileInput !== undefined);
  calls.length = 0;
  Object.defineProperty(fileInput, "files", { value: files, configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();

  const imports = calls.filter((call) => call.method === "importPdf");
  check("the import was sent", imports.length === 1, String(imports.length));
  const sent = imports[0]?.input?.files ?? [];
  check("the client used the Host's cap, not its own fallback",
    sent.length === HOST_LIMIT, `sent ${sent.length}, host limit ${HOST_LIMIT}`);
  // The leftover has to be reported, or 12 picked files and 5 imported is
  // indistinguishable from a 5-file folder.
  const noteText = host.textContent;
  check("the panel says how many files were left over",
    noteText.includes(String(12 - HOST_LIMIT)) || /另有/.test(noteText),
    noteText.slice(0, 200));

  // Per-file coverage lines: "✓ 5" alone would claim five searchable papers while
  // one is metadata-only and one was only partly recognised. The exact wording is
  // the assertion, because a generic note would still satisfy "mentions the file".
  const firstName = sent[0]?.name ?? "paper-0.pdf";
  const secondName = sent[1]?.name ?? "paper-1.pdf";
  const metaLine = `${firstName}: ${t("importNotSearchableReason", { reason: FIRST_IMPORT_FIXTURES[0].ocr.reason })}`;
  const ocrLine = `${secondName}: ${t("importOcrSearchable", {
    n: FIRST_IMPORT_FIXTURES[1].ocr.pagesRecognised,
    m: FIRST_IMPORT_FIXTURES[1].ocr.pagesFailed,
  })}`;
  check("the panel shows why a metadata-only PDF is not searchable",
    noteText.includes(metaLine), `missing ${JSON.stringify(metaLine)} in ${noteText.slice(0, 300)}`);
  check("the panel shows how many OCR pages were recognised and how many failed",
    noteText.includes(ocrLine), `missing ${JSON.stringify(ocrLine)} in ${noteText.slice(0, 300)}`);
}

// --- 3. drag and drop imports -----------------------------------------
{
  calls.length = 0;
  // Not host.firstChild: React prepends a text node, so firstChild is #text and
  // dispatching on it reaches nothing. The behaviour under test lives on the panel
  // element itself.
  const rootNode = host.querySelector(".pt-root");
  check("the panel root is present", rootNode !== null);

  // Dragging over must be accepted, or the drop never fires.
  const dragOver = fireDragEvent(rootNode, "dragover", makeDataTransfer([]));
  check("dragover is prevented so a drop can land", dragOver.defaultPrevented === true, String(dragOver.defaultPrevented));

  // The veil must appear while dragging: it is the only feedback that the panel
  // understood the gesture.
  fireDragEvent(rootNode, "dragenter", makeDataTransfer([]));
  await settle(4);
  const veil = host.querySelector(".pt-drop-veil");
  check("a drop target indicator appears while dragging", veil !== null);
  if (veil !== null) {
    check("the indicator says what will happen", veil.textContent.includes(zh.dropToImport), veil.textContent);
  }

  // Drop two PDFs and a stray text file: only the PDFs may be imported.
  fireDragEvent(rootNode, "drop", makeDataTransfer([
    makePdfFile("dropped-a.pdf"),
    makePdfFile("dropped-b.pdf"),
    makePdfFile("notes.txt"),
  ]));
  await settle();

  const imports = calls.filter((call) => call.method === "importPdf");
  check("a drop triggers exactly one import call", imports.length === 1, String(imports.length));
  const names = (imports[0]?.input?.files ?? []).map((file) => file.name);
  check("the dropped PDFs are imported", names.length === 2, JSON.stringify(names));
  check("a non-PDF dropped alongside is filtered out",
    !names.some((name) => name.endsWith(".txt")), JSON.stringify(names));
  // The veil must be gone once the drop completes.
  check("the drop indicator disappears after the drop", host.querySelector(".pt-drop-veil") === null);
}

// --- 4. dropping a directory walks it ---------------------------------
{
  calls.length = 0;
  const rootNode = host.querySelector(".pt-root");
  // A directory entry containing two PDFs, mimic-ing dropping a Zotero storage
  // folder. `readEntries` deliberately returns everything on the first call here;
  // the "called twice" case is asserted below, because a directory reader that is
  // only called once truncates at 100 entries.
  let readCount = 0;
  const directoryEntry = {
    isFile: false,
    isDirectory: true,
    createReader() {
      return {
        readEntries(onSuccess) {
          readCount += 1;
          if (readCount === 1) {
            onSuccess([
              { isFile: true, isDirectory: false, name: "in-a.pdf", file: (ok) => ok(makePdfFile("in-a.pdf")) },
              { isFile: true, isDirectory: false, name: "in-b.pdf", file: (ok) => ok(makePdfFile("in-b.pdf")) },
              // A nested folder: recursion is what makes a Zotero folder usable.
              {
                isFile: false, isDirectory: true,
                createReader() {
                  let drained = false;
                  return {
                    readEntries(next) {
                      // Real readers drain: entries once, then empty forever.
                      if (drained) { next([]); return; }
                      drained = true;
                      next([{ isFile: true, isDirectory: false, name: "nested.pdf", file: (ok) => ok(makePdfFile("nested.pdf")) }]);
                    },
                  };
                },
              },
            ]);
            return;
          }
          onSuccess([]);
        },
      };
    },
  };
  fireDragEvent(rootNode, "drop", makeDataTransfer([], [directoryEntry]));
  await settle();

  const imports = calls.filter((call) => call.method === "importPdf");
  check("dropping a folder triggers an import", imports.length === 1, String(imports.length));
  const names = (imports[0]?.input?.files ?? []).map((file) => file.name);
  check("the folder's PDFs are imported", names.includes("in-a.pdf") && names.includes("in-b.pdf"), JSON.stringify(names));
  check("a nested folder is walked", names.includes("nested.pdf"), JSON.stringify(names));
  // readEntries must be drained until empty: one call truncates large folders.
  check("the directory reader is drained, not read once", readCount >= 2, String(readCount));
}

// --- 5. the watch toggle reflects and drives the Host -----------------
{
  const initial = allCalls.filter((call) => call.method === "watchStatus");
  check("the panel asks the Host for the watch state on mount", initial.length >= 1, String(initial.length));
  // The badge shows the Host's answer, not a fixed label. Asserting only "shows
  // off" passes if the badge is hardcoded to off — which is exactly the mutation
  // that survived the source grep: `? t("watchOn") : t("watchOff")` became
  // `t("watchOff")` and the panel still read "off".
  check("watching is shown as off when the Host says off",
    host.textContent.includes(zh.watchOff), host.textContent.slice(0, 160));
  check("the badge is driven by the Host's state, not a fixed label",
    /watchState\?\.watching === true \? t\("watchOn"\) : t\("watchOff"\)/.test(readFileSync("client.js", "utf8")));

  calls.length = 0;
  const watchButton = findButton(zh.watch);
  check("there is a control to turn watching on", watchButton !== undefined,
    JSON.stringify(buttons().map((b) => b.textContent.trim())));
  watchButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settle(8);
  // The picker is opened by clicking a hidden <input type="file">. Drive the
  // cancel path: a user who closes the dialog must get an explanation, not a
  // toggle that silently did nothing. The stub cannot fire `oncancel` on its own,
  // so this asserts the handler is installed and the message exists — the
  // alternative (waiting for the 2-minute safety timeout) is not testable.
  const starts = calls.filter((call) => call.method === "watchStart");
  check("no watcher starts without a real folder path",
    starts.every((call) => typeof call.input?.dir === "string" && call.input.dir !== ""),
    JSON.stringify(starts.map((call) => call.input?.dir)));
  check("a cancelled folder pick has a message to show",
    typeof zh.watchNeedsPath === "string" && zh.watchNeedsPath.length > 0, String(zh.watchNeedsPath));
  check("the folder picker can report cancellation",
    /input\.oncancel = /.test(readFileSync("client.js", "utf8")));
}

// --- 6. no unexpected errors -------------------------------------------
{
  const relevant = seenErrors.filter((text) => !/Warning:/.test(text) && !/not wrapped in act/.test(text));
  check("mounting and driving the panel raises no unexpected errors",
    relevant.length === 0, relevant.slice(0, 3).join(" | "));
}

console.log("");
if (failures.length > 0) {
  console.log(`IMPORT-MOUNT FAILED (${failures.length}):`);
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
console.log("IMPORT-MOUNT PASS");

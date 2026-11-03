// Directory import, drag-and-drop, single-source limits, opt-in folder watching
// (PT-017).
//
// What this gate is for. The original three claims were "no directory pick",
// "32-file cap declared twice", "no drag and drop". Two of those are greppable;
// the interesting ones are not:
//
//   - The cap was declared in two places, so the real defect is not "32 is too
//     small" but "the client and the Host can disagree about how large 32 is".
//     Asserting the constant exists would pass while the two copies drifted.
//   - A watch folder that imports an unfinished PDF does not fail loudly — it
//     imports a truncated paper. Grepping for `fs.watch` would pass while every
//     large file produced garbage.
//
// So the assertions here are about behaviour: a batch larger than the cap must
// report what it did not process, and an unsettled file must not be imported.
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();
const { isStable, isPdfName, SettleTracker } = await import("../lib/watch.js");

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}
function checkEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

const client = readFileSync("client.js", "utf8");
const host = readFileSync("lib/host-service.js", "utf8");

function makeService() {
  const home = mkdtempSync(join(tmpdir(), "pt017-home-"));
  const work = mkdtempSync(join(tmpdir(), "pt017-work-"));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  const scope = { sessionId: "pt017", workspaceRoot: work };
  return {
    service,
    scope,
    cleanup() {
      service.dispose();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

// --- 1. the limits have a single source ---------------------------------
// The client must not carry its own authoritative copy. A fallback is allowed —
// the panel renders before the first status reply — but the value that decides
// behaviour has to come from the Host.
{
  const declared = [...client.matchAll(/const MAX_IMPORT_FILES[A-Z_]* = (\d+);/g)].map((m) => m[1]);
  check("the client declares no authoritative file cap",
    !/const MAX_IMPORT_FILES = \d+;/.test(client), declared.join(","));
  check("the client keeps only a fallback cap",
    /const MAX_IMPORT_FILES_FALLBACK = \d+;/.test(client));
  check("the client reads the cap from status",
    /state\.limits\.maxImportFiles/.test(client) && /setImportLimits/.test(client));
  check("the Host declares the cap once",
    (host.match(/const MAX_IMPORT_FILES = \d+;/g) ?? []).length === 1,
    String((host.match(/const MAX_IMPORT_FILES = \d+;/g) ?? []).length));
  check("the Host publishes the cap in status",
    /maxImportFiles: MAX_IMPORT_FILES/.test(host) && /maxPdfBytes: MAX_PDF_BYTES/.test(host));

  const { service, scope, cleanup } = makeService();
  const status = await service.status(scope);
  check("status really carries the limits",
    status.limits?.maxImportFiles === 32 && status.limits?.maxPdfBytes === 64 * 1024 * 1024,
    JSON.stringify(status.limits));
  cleanup();
}

// --- 2. over the limit is processed, not refused ------------------------
// A folder of 41 files must import 32 and say 9 were left behind. Refusing all
// 41 leaves the user to guess which 32 to pick by hand; silently importing 32
// makes "41 files" and "32 files" indistinguishable in the result.
{
  const { service, scope, cleanup } = makeService();
  // A minimal but genuinely valid single-page PDF: the import path runs real
  // pdf.js extraction, so a fake byte string would fail for the wrong reason.
  const pageStream = "BT /F1 12 Tf 72 720 Td (Test paper on methods) Tj ET";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${pageStream.length} >>\nstream\n${pageStream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const pdfBytes = Array.from(new TextEncoder().encode(body));

  // 41 distinct files: same shape, different title, so fingerprints differ and
  // each one is a separate paper rather than a duplicate of the last.
  const files = [];
  for (let index = 0; index < 41; index += 1) {
    const named = body.replace("(Test paper on methods)", `(Test paper number ${index} on methods)`);
    files.push({ name: `paper-${String(index).padStart(2, "0")}.pdf`, data: Array.from(new TextEncoder().encode(named)) });
  }
  const result = await service.importPdf(scope, { files });
  check("an over-limit batch is not rejected", Array.isArray(result.imported), JSON.stringify(Object.keys(result)));
  check("it imports up to the cap", result.imported.length === 32, String(result.imported.length));
  check("it reports how many were not processed", result.remaining === 9, String(result.remaining));
  check("it states the cap that applied", result.limit === 32, String(result.limit));
  check("nothing was reported as failed just for being over the cap",
    result.failed.length === 0, result.failed.map((item) => item.reason).join(";"));
  // The 32 that were processed are real papers, not empty stubs.
  const stats = service.storeFor(scope).stats();
  check("the processed files became papers", stats.papers === 32, String(stats.papers));

  // The client must surface that number, not just import in silence.
  check("the client reports the leftover count",
    /t\("importLeftover"/.test(client) && /notHandled/.test(client));
  check("the client does not abort the whole batch on one oversized file",
    /tooLarge\.push/.test(client) && !/if \(file\.size > maxBytes\) \{\s*setError/.test(client));
  cleanup();
}

// --- 3. the stability rule -------------------------------------------
// The rule is a pure function so it can be tested without a real watcher.
{
  const sample = (size, mtimeMs) => ({ size, mtimeMs });
  check("a first sample is never stable", isStable(null, sample(100, 1)) === false);
  check("a growing file is not stable", isStable(sample(100, 1), sample(200, 2)) === false);
  check("a file re-written with the same size but a new mtime is not stable",
    isStable(sample(100, 1), sample(100, 2)) === false);
  check("two identical samples are stable", isStable(sample(100, 1), sample(100, 1)) === true);
  check("an empty file is never stable", isStable(sample(0, 1), sample(0, 1)) === false);
  // An empty file being "stable" would import a 0-byte PDF, which fails
  // extraction and lands in the library as a failed row.
  check("a null current sample is not stable", isStable(sample(1, 1), null) === false);
}

// --- 4. settle tracking reports once ----------------------------------
{
  let clock = 0;
  const tracker = new SettleTracker({ quietMs: 1000, now: () => clock });
  const path = "/watched/paper.pdf";
  check("the first offer starts observing", tracker.offer(path, { size: 10, mtimeMs: 1 }) === false);
  clock = 100;
  check("a mid-write sample restarts the clock",
    tracker.offer(path, { size: 500, mtimeMs: 5 }) === false);
  check("still within the quiet window", tracker.offer(path, { size: 500, mtimeMs: 5 }) === false);
  clock = 1400;
  check("once quiet it reports settled", tracker.offer(path, { size: 500, mtimeMs: 5 }) === true);
  // Reporting twice for one file is how a single drop becomes two library rows.
  check("a settled path is not reported twice", tracker.offer(path, { size: 500, mtimeMs: 5 }) === false);
  // It is back under observation, not forgotten: a file can be replaced at the
  // same path (a re-downloaded paper), and that must be imported again. What must
  // not happen is a *second report without a new sample*.
  check("a settled path goes back under observation rather than being reported again",
    tracker.size === 1, String(tracker.size));
  tracker.forget(path);
  check("forgetting clears the observation", tracker.size === 0, String(tracker.size));

  check("a non-PDF is not a candidate", isPdfName("notes.txt") === false);
  check("PDF matching is case-insensitive", isPdfName("Paper.PDF") === true);
}

// --- 5. the watch folder is opt-in and reports its state ---------------
{
  const { service, scope, cleanup } = makeService();
  const initial = await service.watchStatus(scope);
  check("watching is off by default", initial.watching === false, JSON.stringify(initial));
  check("the default state names no folder", initial.dir === null, String(initial.dir));

  // Nothing starts a watcher on construction: a background job that writes into
  // the user's library by default is how someone ends up with papers they never
  // imported.
  check("the service does not start a watcher on its own",
    service.watchState === null, String(service.watchState));

  const missing = await service.watchStart(scope, { dir: join(scope.workspaceRoot, "nope") })
    .then(() => null).catch((error) => error);
  check("watching a non-existent folder is refused", missing !== null && /no-such-dir/.test(missing.code ?? ""),
    String(missing?.code));

  const dir = join(scope.workspaceRoot, "watched");
  mkdirSync(dir, { recursive: true });
  const started = await service.watchStart(scope, { dir });
  check("an explicit start turns watching on", started.watching === true, JSON.stringify(started));
  check("the status names the folder", started.dir === dir, String(started.dir));

  // Put a PDF in and let the poll notice it. The watcher imports through the real
  // extraction path, so this is the same code the manual import uses.
  const pageStream = "BT /F1 12 Tf 72 720 Td (Watched paper) Tj ET";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${pageStream.length} >>\nstream\n${pageStream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  writeFileSync(join(dir, "dropped.pdf"), body, "utf8");

  const deadline = Date.now() + 20_000;
  let stats = service.storeFor(scope).stats();
  while (stats.papers === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    stats = service.storeFor(scope).stats();
  }
  check("a PDF dropped in the watched folder is imported without a click",
    stats.papers === 1, `papers=${stats.papers}`);
  // Dedupe: the same file must not become a second row. Sample twice so a
  // re-import triggered by a later event has time to appear.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  stats = service.storeFor(scope).stats();
  check("the same file is not imported twice", stats.papers === 1, `papers=${stats.papers}`);
  const failedRows = service.storeFor(scope).listPapers({ limit: 10 })
    .filter((row) => row.material === "failed");
  check("no failed row was written for a settled file", failedRows.length === 0, String(failedRows.length));

  // Capture the live watcher before stopping: asserting only `watchState === null`
  // passes even if `watcher.close()` was deleted, because the reference is
  // dropped either way. What matters is that the OS handle was actually closed.
  const live = service.watchState;
  let closedFlag = false;
  const realClose = live.watcher.close.bind(live.watcher);
  live.watcher.close = () => { closedFlag = true; realClose(); };
  // Observe clearInterval on this specific timer handle rather than trusting the
  // source text: the timer must actually be cancelled.
  let timerCleared = false;
  const realClearInterval = globalThis.clearInterval;
  globalThis.clearInterval = (handle) => {
    if (handle === live.timer) timerCleared = true;
    return realClearInterval(handle);
  };
  const stopped = await service.watchStop(scope);
  check("an explicit stop turns watching off", stopped.watching === false, JSON.stringify(stopped));
  check("the watcher handle is released", service.watchState === null);
  check("stopping actually closes the filesystem watcher", closedFlag === true);
  // The two guards are independent on purpose: the poll timer is cleared AND the
  // tick re-checks identity. Removing either alone must be visible, because the
  // surviving one hides a real regression (a cleared timer that is re-created, or
  // an identity check on a timer that keeps firing).
  check("stopping clears the poll timer, not just the flag", timerCleared === true);
  check("a tick from a stopped watcher is a no-op",
    /if \(this\.watchState !== state\) return;/.test(readFileSync("lib/host-service.js", "utf8")));

  // A fresh file after the stop must not be imported. This is the assertion that
  // catches "stop clears the pointer but leaves the poll running": the timer
  // still holds the old state object and would keep importing into the library.
  writeFileSync(join(dir, "after-stop.pdf"), body.replace("(Watched paper)", "(After stop)"), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  globalThis.clearInterval = realClearInterval;
  check("a file added after the stop is not imported",
    service.storeFor(scope).stats().papers === 1, String(service.storeFor(scope).stats().papers));

  // dispose must release the watcher too: the service is rebuilt on every plugin
  // reload, and a leaked watcher keeps writing into the library after the store
  // that owns it is closed.
  const again = await service.watchStart(scope, { dir });
  check("watching can be started again after a stop", again.watching === true, JSON.stringify(again));
  const live2 = service.watchState;
  let closedByDispose = false;
  const realClose2 = live2.watcher.close.bind(live2.watcher);
  live2.watcher.close = () => { closedByDispose = true; realClose2(); };
  service.dispose();
  check("dispose closes the filesystem watcher", closedByDispose === true);
  cleanup();
}

// --- 6. the client wiring exists --------------------------------------
{
  check("directory picking is offered", /webkitdirectory/.test(client));
  check("a drop handler is bound", /onDrop: onPanelDrop/.test(client));
  check("drag-over is prevented so drop can fire", /onDragOver: onPanelDragOver/.test(client));
  check("a dropped directory is walked, not ignored", /webkitGetAsEntry/.test(client) && /readEntries/.test(client));
  check("the drop veil tells the user what will happen", /dropToImport/.test(client));
  check("the watch bar reflects the Host state", /watchStatus/.test(client) && /watchStart/.test(client));
  check("the Host marks the watch RPCs", /"watchStart",\s*\n\s*"watchStop",\s*\n\s*"watchStatus",/.test(host));
}

console.log("");
if (failures.length > 0) {
  console.log(`IMPORT-017 FAILED (${failures.length}):`);
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
console.log("IMPORT-017 PASS");

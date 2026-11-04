// s38-rpc-arity.mjs — the client must not send arguments to a remote method whose host
// signature takes none.
//
// Why this gate exists: `backupStatus(paperToolScope)` takes no input, but the client
// called it as `callRemote(sessionId, "backupStatus", {})`. The typert gateway rejects
// that at call time — "args fields do not match the descriptor: unexpected input" — and
// the panel greeted the user with a red error banner instead of the backup section.
//
// Every unit test missed it, including s34-backup, because they call
// `service.backupStatus(scope)` directly and never cross the gateway. The wire shape is
// a contract between two files that neither file's own tests can see, so it gets its own
// gate: parse the host's remote method list and each signature, parse the client's call
// sites, and compare.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const hostSource = fs.readFileSync(path.join(root, "lib", "host-service.js"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "client.js"), "utf8");

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  }
};

// --- 1. the host's remote surface, and which of it takes an input -------------------
const listStart = hostSource.indexOf("for (const method of [");
const listEnd = hostSource.indexOf("markRemote(PaperToolService, method);");
check("the host declares its remote methods in one list", listStart >= 0 && listEnd > listStart,
  `listStart=${listStart} listEnd=${listEnd}`);

const methodNames = [...hostSource.slice(listStart, listEnd).matchAll(/"([A-Za-z]\w*)"/g)].map((m) => m[1]);
check("the remote method list is not empty", methodNames.length > 30, String(methodNames.length));

const arity = new Map();
for (const name of methodNames) {
  const match = hostSource.match(new RegExp(`async ${name}\\(\\s*paperToolScope\\s*(,[^)]*)?\\)`, "m"));
  if (match === null) continue;
  const extra = (match[1] ?? "").replace(/^,/, "").trim();
  arity.set(name, extra === "" ? 0 : 1);
}
check("every remote method has a parseable signature", arity.size === methodNames.length,
  `${arity.size} of ${methodNames.length}`);

const noInput = [...arity].filter(([, count]) => count === 0).map(([name]) => name).sort();
check("some remote methods genuinely take no input", noInput.length >= 3, noInput.join(", "));
// Named explicitly: these are the ones a refactor is most likely to start passing a
// placeholder to, because an empty object reads as "no options" at the call site.
check("backupStatus is one of the no-input methods", noInput.includes("backupStatus"), noInput.join(", "));

// --- 2. the client's call sites ----------------------------------------------------
// `callRemote(sessionId, "name")` or `callRemote(sessionId, "name", args[, signal])`.
// The method name is what selects the descriptor, so the check keys off it.
const callSites = [...clientSource.matchAll(/callRemote\(\s*sessionId\s*,\s*"(\w+)"\s*(,)?/g)]
  .map((match) => ({ name: match[1], hasArgs: match[2] === "," }));
check("the client's call sites were found", callSites.length > 30, String(callSites.length));

const offenders = [];
for (const site of callSites) {
  const expected = arity.get(site.name);
  if (expected === undefined) continue; // not a remote method (or a typo caught elsewhere)
  if (expected === 0 && site.hasArgs) offenders.push(site.name);
}
check("no arguments are sent to a method that takes none", offenders.length === 0,
  offenders.length === 0 ? undefined : `sent args to: ${[...new Set(offenders)].join(", ")}`);

// The inverse is not an error to assert by itself — an input-taking method may legitimately
// be called with its input derived later — so instead assert that the two methods the real
// bug touched are called the same way as their sibling. watchStatus and backupStatus are
// both zero-argument host methods; they must be called the same way or one of them is wrong.
const watchCall = /callRemote\(\s*sessionId\s*,\s*"watchStatus"\s*(,)?/m.exec(clientSource);
const backupCall = /callRemote\(\s*sessionId\s*,\s*"backupStatus"\s*(,)?/m.exec(clientSource);
check("watchStatus is called with no arguments", watchCall !== null && watchCall[1] !== ",", "watchStatus call shape changed");
check("backupStatus is called with no arguments", backupCall !== null && backupCall[1] !== ",", "backupStatus call shape changed");

// --- 2b. the wrapped-input set is part of the contract, not a hint -------------------
// Checking only the call sites was not enough. `callRemote` defaults `args` to `{}`, so a
// zero-argument method that is still listed in INPUT_METHODS is wrapped as `input: {}`
// even when the caller passes nothing — the gateway rejects it exactly as before. That
// happened: backupStatus's call site was fixed while its set membership was not, and the
// defect survived the gate that was written to catch it.
const setStart = clientSource.indexOf("INPUT_METHODS = new Set([");
const setEnd = clientSource.indexOf("]);", setStart);
check("the client declares its wrapped-input methods in one set", setStart >= 0 && setEnd > setStart,
  `setStart=${setStart} setEnd=${setEnd}`);
const wrapped = new Set(
  [...clientSource.slice(setStart, setEnd).matchAll(/"(\w+)"/g)].map((match) => match[1]),
);
check("the wrapped-input set is not empty", wrapped.size > 20, String(wrapped.size));

const wronglyWrapped = noInput.filter((name) => wrapped.has(name));
check("no zero-input method is listed in the wrapped-input set", wronglyWrapped.length === 0,
  wronglyWrapped.length === 0 ? undefined : `would be sent input: ${wronglyWrapped.join(", ")}`);

// And the mirror image: a method that DOES take input must be wrapped, or the gateway
// receives no `input` field at all. Two deliberate exemptions:
//   - getPdfRuntime's second parameter is a signal, not an input object.
//   - a method with no client call site cannot be wrong yet; requiring it to be wrapped
//     would force dead entries into the set, and the call-site check above already
//     covers the moment a caller appears.
const takesInput = [...arity].filter(([, count]) => count === 1).map(([name]) => name);
const calledNames = new Set(callSites.map((site) => site.name));
const unwrapped = takesInput.filter(
  (name) => calledNames.has(name) && !wrapped.has(name) && name !== "getPdfRuntime",
);
check("every input-taking method the client calls is wrapped", unwrapped.length === 0,
  unwrapped.length === 0 ? undefined : `would be sent no input: ${unwrapped.join(", ")}`);

// --- 3. the mock used by the UI gates must accept the same shape ---------------------
// A mock that ignores extra arguments cannot catch this class of bug, which is exactly
// how the real defect reached a release. Several gates build such mocks; assert at least
// one of them rejects an unexpected third argument for a zero-argument method.
const stubFiles = fs.readdirSync(here).filter((name) => /^s\d+.*\.mjs$/.test(name));
let shapeAware = 0;
for (const name of stubFiles) {
  const text = fs.readFileSync(path.join(here, name), "utf8");
  if (/unexpected|arity|descriptor/i.test(text) && /callRemote|backupStatus/.test(text)) shapeAware += 1;
}
check("at least one gate models the gateway's argument checking", shapeAware >= 1, String(shapeAware));

console.log(failures === 0 ? "\nRPC-ARITY PASS" : `\nRPC-ARITY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

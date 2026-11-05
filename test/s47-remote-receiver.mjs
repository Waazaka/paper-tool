// Gate: a Remote method must not touch a `#private` member of the service class.
//
// This is the defect that shipped past 52 green gates and every unit test, and it was
// found only by clicking 导入 PDF in a live panel:
//
//   RemoteError: Receiver must be an instance of class PaperToolService
//
// The Typert gateway does not call a Remote method on the service instance. It resolves
// the service through the context, then EXTENDS that receiver for the invocation
// (`receiverContext.extend({ invocation })`) and dispatches with
// `Reflect.apply(prepared.method, prepared.receiver, prepared.args)`. A `#private`
// method is brand-checked against the receiver, and a derived object fails that check
// even though it inherits everything else. So any Remote method that called a private
// helper failed at RPC time while working perfectly when called directly — which is
// exactly how the unit tests call it.
//
// The rule this gate enforces, therefore, is not "avoid private methods" as style: it is
// that the service class must expose no private member at all, because every helper in
// it is reachable from a Remote entry point and the receiver contract cannot tell the
// difference. A private field that is genuinely unreachable would be fine in principle,
// but nothing in this file can prove unreachability, and a rule the gate cannot check is
// worse than a rule that is slightly too broad.
//
// Part 1 reads the real dispatch code out of the installed bundle, so the reasoning is
// pinned to what DSH actually does rather than to a comment. It SKIPS loudly when the
// bundle cannot be read.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { report } from "./report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const hostSource = fs.readFileSync(path.join(root, "lib", "host-service.js"), "utf8");

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else { console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail)); failures.push(name); }
}

// --- 1. the gateway dispatches on a derived receiver -------------------
const bundleCandidates = [
  "C:/Users/wazaka/AppData/Local/Programs/DeepSeek Harness/resources/app.asar",
  path.join(process.env.LOCALAPPDATA ?? "", "Programs/DeepSeek Harness/resources/app.asar"),
];
const bundlePath = bundleCandidates.find((candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
});
if (bundlePath === undefined) {
  console.log("  SKIP the installed DSH bundle was not found; the receiver contract cannot be judged");
  console.log("");
  console.log("REMOTE-RECEIVER SKIP");
  process.exit(report({ failures: 0, skipped: true, skipReason: "no installed bundle" }));
}
const bundleText = fs.readFileSync(bundlePath).toString("utf8");

const gatewayAt = bundleText.indexOf("async prepareInvocation(request, control)");
check("the gateway's prepareInvocation was found in the installed bundle", gatewayAt >= 0, String(gatewayAt));
if (gatewayAt >= 0) {
  // The precise sequence that matters, in the order it happens.
  const body = bundleText.slice(gatewayAt, gatewayAt + 4000);
  const extendedAt = body.indexOf("receiverContext.extend(");
  const dispatchAt = body.indexOf("receiver: callReceiver");
  check("the gateway extends the resolved receiver for the call", extendedAt >= 0, String(extendedAt));
  check("the gateway dispatches on that extended receiver, not the raw instance",
    dispatchAt >= 0 && extendedAt >= 0 && extendedAt < dispatchAt,
    `extend@${extendedAt} dispatch@${dispatchAt}`);
  const invokeAt = bundleText.indexOf("async invokePrepared(prepared)");
  const applyAt = invokeAt >= 0 ? bundleText.indexOf("Reflect.apply(prepared.method, prepared.receiver", invokeAt) : -1;
  check("invokePrepared really calls Reflect.apply on prepared.receiver", applyAt > invokeAt && invokeAt >= 0,
    `invoke@${invokeAt} apply@${applyAt}`);
}

// The same behaviour, demonstrated rather than asserted: a private method is callable on
// the instance and throws on a derived receiver. If this ever stops being true the rule
// below is obsolete, and this check says so instead of leaving a stale ban in place.
{
  class Demo {
    #secret() { return 42; }
    direct() { return this.#secret(); }
  }
  const instance = new Demo();
  const derived = Object.create(instance);
  let directValue;
  try { directValue = instance.direct(); } catch (error) { directValue = String(error?.message); }
  let derivedError = null;
  try { derived.direct(); } catch (error) { derivedError = String(error?.message ?? error); }
  check("a private method works on the instance", directValue === 42, JSON.stringify(directValue));
  check("the same method throws on a derived receiver, reproducing the live failure",
    derivedError !== null && /Receiver must be an instance of class/.test(derivedError),
    JSON.stringify(derivedError));
}

// --- 2. the service class declares no private member -------------------
// Only DECLARATIONS count here: `#` inside a comment or a string is not a member. The
// modifier prefix matters — `async #enrichOne(...)` slipped past an earlier version of
// this pattern because it only allowed `static`, and a mutation that reintroduced the
// real bug was reported as MISSED while the gate looked green.
const classAt = hostSource.indexOf("export class PaperToolService");
check("the service class was found", classAt >= 0, String(classAt));
const classBody = hostSource.slice(classAt);
const declarations = [...classBody.matchAll(/^\s*(?:(?:static|async|get|set)\s+)*#([A-Za-z_$][\w$]*)\s*[=(]/gm)].map((match) => match[1]);
check("the service class declares no private members",
  declarations.length === 0,
  declarations.length === 0 ? "" : declarations.join(", "));
// Prove the pattern above can actually see one, so "no declarations found" is never a
// silent regex failure. This is the same shape the real defect had.
const probe = "export class PaperToolService {\n  async #enrichOne(store, paperId) {\n  }\n}\n";
const probeHits = [...probe.matchAll(/^\s*(?:(?:static|async|get|set)\s+)*#([A-Za-z_$][\w$]*)\s*[=(]/gm)].map((m) => m[1]);
check("the declaration pattern detects an async private method", probeHits.join(",") === "enrichOne", probeHits.join(","));

// --- 3. nothing in lib/ reaches one through `this.#` -------------------
const offenders = [];
const libDir = path.join(root, "lib");
for (const entry of fs.readdirSync(libDir)) {
  if (!entry.endsWith(".js")) continue;
  const text = fs.readFileSync(path.join(libDir, entry), "utf8");
  // Strip line comments so the explanatory comment left behind by the fix does not
  // count as a use. Block comments are rare here; line comments are what this file uses.
  const stripped = text.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  const uses = [...stripped.matchAll(/this\.#([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  if (uses.length > 0) offenders.push(`${entry}: ${uses.join(", ")}`);
}
check("no lib file reaches a private member through this.#", offenders.length === 0, offenders.join(" | "));

// --- 4. the Remote entry points still exist ----------------------------
// Cheap sanity that this gate is looking at the real thing: if the method list moved or
// the marker loop was renamed, parts 2 and 3 above would pass vacuously.
const listStart = hostSource.indexOf("for (const method of [");
const listEnd = hostSource.indexOf("markRemote(PaperToolService, method);");
check("the Remote method list was found", listStart >= 0 && listEnd > listStart,
  `start@${listStart} end@${listEnd}`);
if (listStart >= 0 && listEnd > listStart) {
  const methods = [...hostSource.slice(listStart, listEnd).matchAll(/"([A-Za-z]\w*)"/g)].map((match) => match[1]);
  check("the Remote method list is not empty", methods.length >= 20, String(methods.length));
  check("importPdf is a Remote method — the one that failed live", methods.includes("importPdf"));
  // Every listed method must exist as a plain (non-private) method on the class.
  const missing = methods.filter((method) => !new RegExp(`^\\s*async ${method}\\(`, "m").test(hostSource));
  check("every Remote method is declared as a plain method", missing.length === 0, missing.join(", "));
}

console.log("");
if (failures.length === 0) console.log("REMOTE-RECEIVER PASS");
else console.log(`REMOTE-RECEIVER FAIL (${failures.length}): ${failures.join("; ")}`);
process.exit(report({ failures: failures.length }));

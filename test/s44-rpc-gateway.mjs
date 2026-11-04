// Gate: every RPC the client actually calls must produce arguments the gateway accepts,
// judged by the gateway's OWN rule rather than by our reading of it.
//
// Background. The typert gateway validates remote arguments with an exact key-set
// comparison: the descriptor's parameter wire names must equal the args object's keys.
// Missing one is `missing "input"`; an extra one is `unexpected "input"`. Both are hard
// failures at call time and surface as a red banner in the panel.
//
// Two real defects came from this, in opposite directions:
//   - backupStatus takes no input, but was listed in the client's INPUT_METHODS, so
//     `callRemote` wrapped `input: {}` anyway (it defaults args to {}). The call site
//     looked fixed and the bug was not.
//   - the four annotation RPCs take an input, but were NOT listed, so their arguments
//     were spread at the top level and the required `input` field was missing entirely.
// Text-matching the client and host sources cannot decide either case for certain: the
// wire name comes from the descriptor, not from the source text. So this gate loads the
// real `assertExactArguments` out of the installed DSH bundle, builds the descriptor the
// same way the gateway does (from the method's parameter list), and runs the client's
// actual payload through it.
//
// If the installed bundle cannot be read, the gate SKIPS loudly — it never passes on a
// missing dependency, because a silent pass here would be worse than no gate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const clientSource = fs.readFileSync(path.join(root, "client.js"), "utf8");
const hostSource = fs.readFileSync(path.join(root, "lib", "host-service.js"), "utf8");

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else { console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail)); failures.push(name); }
}

// --- locate the installed DSH bundle ---------------------------------
const candidates = [
  "C:/Users/wazaka/AppData/Local/Programs/DeepSeek Harness/resources/app.asar",
  path.join(process.env.LOCALAPPDATA ?? "", "Programs/DeepSeek Harness/resources/app.asar"),
];
const bundlePath = candidates.find((candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
});
if (bundlePath === undefined) {
  console.log("  SKIP the installed DSH bundle was not found; cannot judge the wire contract");
  console.log("");
  console.log("RPC-GATEWAY SKIP");
  process.exit(0);
}

const bundleText = fs.readFileSync(bundlePath).toString("utf8");
const assertAt = bundleText.indexOf("function assertExactArguments(");
if (assertAt < 0) {
  console.log("  SKIP assertExactArguments was not found in the installed bundle");
  console.log("");
  console.log("RPC-GATEWAY SKIP");
  process.exit(0);
}
// Pull the function out and evaluate it with the gateway's own helpers stubbed to the
// same observable behaviour (a thrown error carrying the same message text).
const source = bundleText.slice(assertAt, assertAt + 2000);
const end = source.indexOf("\n}\n");
const fnText = source.slice(0, end + 3);
check("the gateway's argument checker was extracted", fnText.includes("missing") && fnText.includes("unexpected"),
  String(fnText.length));

const TypertGatewayError = class extends Error {
  constructor(code, endpoint, message) { super(message); this.code = code; this.endpoint = endpoint; }
};
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const assertExactArguments = new Function(
  "TypertGatewayError", "isPlainObject",
  `${fnText}\nreturn assertExactArguments;`,
)(TypertGatewayError, isPlainObject);

function gatewayAccepts(args, wireNames) {
  try {
    // Each parameter needs a codec: the gateway's `acceptsMissing` pass reads
    // `parameter.codec.mode` to decide whether a JSON parameter may be absent. The real
    // gateway sets every SRC parameter to `src-json`, which is exactly the mode that
    // makes an absent `input` acceptable — which is why `backupStatus` with an input
    // field is an `unexpected` error while a missing one would not be. Modelling the
    // codec faithfully is what makes this gate agree with the real gateway.
    assertExactArguments(
      args,
      {
        parameters: wireNames.map((wire) => ({
          name: wire,
          wire,
          source: "json",
          codec: { mode: "src-json" },
        })),
        invocation: { kind: "call" },
      },
      "test/endpoint",
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Sanity: the extracted checker must actually reject both kinds of mismatch, otherwise
// every assertion below would pass vacuously.
check("the extracted checker rejects a missing parameter",
  gatewayAccepts({ a: 1 }, ["input"]).ok === false,
  JSON.stringify(gatewayAccepts({ a: 1 }, ["input"])));
check("the extracted checker rejects an unexpected parameter",
  gatewayAccepts({ a: 1, b: 2 }, ["a"]).ok === false,
  JSON.stringify(gatewayAccepts({ a: 1, b: 2 }, ["a"])));
check("the extracted checker accepts an exact match",
  gatewayAccepts({ input: {} }, ["input"]).ok === true);

// --- the client's real transport -------------------------------------
const setStart = clientSource.indexOf("INPUT_METHODS = new Set([");
const setEnd = clientSource.indexOf("]);", setStart);
const wrapped = new Set([...clientSource.slice(setStart, setEnd).matchAll(/"(\w+)"/g)].map((m) => m[1]));
check("the client's wrapped-input set was found", wrapped.size > 20, String(wrapped.size));

// The host's parameter list per remote method, which is what the descriptor is built from.
const listStart = hostSource.indexOf("for (const method of [");
const listEnd = hostSource.indexOf("markRemote(PaperToolService, method);");
const methods = [...hostSource.slice(listStart, listEnd).matchAll(/"([A-Za-z]\w*)"/g)].map((m) => m[1]);

const params = new Map();
for (const name of methods) {
  const match = hostSource.match(new RegExp(`async ${name}\\(([^)]*)\\)`, "m"));
  if (match === null) continue;
  params.set(name, match[1].split(",").map((part) => part.trim()).filter(Boolean));
}
check("every remote method's parameter list was parsed", params.size === methods.length,
  `${params.size} of ${methods.length}`);

// The wire name of each parameter is its own name. `paperToolScope` is a LOOKUP
// parameter (`LOOKUP = "paperToolScope"` in the host), and lookup parameters are resolved
// by the gateway from the connection — they are NOT part of the args object the client
// sends. `signal` is transport, not JSON. So the args payload is exactly:
//   { paperSessionId }                      for a zero-input method
//   { paperSessionId, input: <args> }       for a wrapped method
// and the descriptor's own parameter list is only the business parameters. The check
// below reproduces that separation instead of guessing at it.
const SCOPE = "paperToolScope";
const TRANSPORT = new Set(["signal"]);
const SESSION_FIELD = "paperSessionId";
function businessParamsOf(name) {
  const list = params.get(name) ?? [];
  return list.filter((part) => part !== SCOPE && !TRANSPORT.has(part));
}

// Reproduce `callRemote` exactly.
function payloadFor(sessionId, method, args = {}) {
  return wrapped.has(method)
    ? { paperSessionId: sessionId, input: args }
    : { paperSessionId: sessionId, ...args };
}

// --- 1. zero-input methods must not be wrapped ------------------------
{
  const zeroInput = [...params].filter(([, list]) => businessParamsOf.length === 0 || list.filter((p) => p !== SCOPE && !TRANSPORT.has(p)).length === 0)
    .map(([name]) => name);
  check("some remote methods take no input", zeroInput.length >= 3, zeroInput.join(", "));
  const offenders = zeroInput.filter((name) => wrapped.has(name));
  check("no zero-input method is wrapped", offenders.length === 0, offenders.join(", "));
  // Their payload must be exactly the session field, and nothing else.
  for (const name of zeroInput) {
    const payload = payloadFor("s1", name);
    const verdict = gatewayAccepts(payload, [SESSION_FIELD]);
    check(`${name}: the gateway accepts the payload`, verdict.ok, verdict.reason);
  }
}

// --- 2. every called, input-taking method must be wrapped ------------
{
  const callSites = [...clientSource.matchAll(/callRemote\(\s*sessionId\s*,\s*"(\w+)"\s*(,)?/g)]
    .map((match) => ({ name: match[1], hasArgs: match[2] === "," }));
  check("the client's call sites were found", callSites.length > 30, String(callSites.length));

  const called = new Set(callSites.map((site) => site.name));
  const inputTaking = [...params].filter(([, list]) =>
    list.filter((p) => p !== SCOPE && !TRANSPORT.has(p)).length > 0).map(([name]) => name);

  const unwrapped = inputTaking.filter((name) => called.has(name) && !wrapped.has(name));
  check("every input-taking method the client calls is wrapped", unwrapped.length === 0,
    `would be sent no input: ${unwrapped.join(", ")}`);

  // The decisive check: run each called method's real payload through the gateway rule.
  // The descriptor's expected keys are the session field plus the business parameters.
  const rejected = [];
  for (const site of callSites) {
    if (!params.has(site.name)) continue;
    const args = site.hasArgs ? { someArg: 1 } : {};
    const payload = payloadFor("s1", site.name, args);
    const expected = [SESSION_FIELD, ...businessParamsOf(site.name)];
    const verdict = gatewayAccepts(payload, expected);
    if (!verdict.ok) rejected.push(`${site.name}: ${verdict.reason}`);
  }
  check("every called method's payload passes the gateway's argument check", rejected.length === 0,
    rejected.join(" | "));
}

console.log("");
if (failures.length > 0) {
  console.log("RPC-GATEWAY FAILED (" + failures.length + "):");
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("RPC-GATEWAY PASS");

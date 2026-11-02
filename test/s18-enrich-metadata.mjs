// Gate: DOI enrichment logic.
//
// `test/metadata-enrich.test.js` uses node:test, which the rest of the suite does
// not; that kept it out of `node test/all.mjs` and therefore out of the only signal
// that actually runs. A test nobody runs is worse than no test: it looks like
// coverage. This gate runs it and folds its verdict into the common
// "GATES FAILED (n)" shape so a regression fails the suite.
//
// No corpus and no network: every case is a pure function or an explicitly aborted
// request, so this is deterministic on an offline machine.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = import.meta.dirname;
const result = spawnSync(process.execPath, ["--test", join(dir, "metadata-enrich.test.js")], {
  cwd: join(dir, ".."),
  encoding: "utf8",
  timeout: 120_000,
});
const text = (result.stdout ?? "") + (result.stderr ?? "");

// node:test prints "ℹ pass 12" / "ℹ fail 0"; report those rather than exit codes
// alone, because a crashed runner also exits non-zero but has no counts at all.
const pass = Number((text.match(/^ℹ pass (\d+)/m) ?? [])[1] ?? -1);
const fail = Number((text.match(/^ℹ fail (\d+)/m) ?? [])[1] ?? -1);

if (pass < 0 || fail < 0) {
  console.log(text.trim());
  console.log("\nENRICH-METADATA FAILED (1):");
  console.log(" - the unit runner produced no pass/fail counts");
  process.exit(1);
}
console.log(`  pass ${pass}`);
console.log(`  fail ${fail}`);
// Zero passes is not a pass: an empty or skipped file would otherwise look green.
const problems = [];
if (fail !== 0) problems.push(`${fail} case(s) failed`);
if (pass === 0) problems.push("no cases ran");

if (problems.length > 0) {
  console.log(text.trim());
  console.log("\nENRICH-METADATA FAILED (" + problems.length + "):");
  for (const p of problems) console.log(" - " + p);
  process.exit(1);
}
console.log("\nENRICH-METADATA PASS");

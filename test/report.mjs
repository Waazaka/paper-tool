// Shared verdict reporting for the gates.
//
// The harness sandbox forbids a child process from writing to an inherited pipe,
// so `spawnSync` cannot read a gate's stdout. Gates therefore record their
// verdict in the file named by PAPER_TOOL_RESULT_FILE (set by test/all.mjs) and
// the runner reads it back. Running a gate directly still prints to the console,
// so a developer sees the same output either way.
import { writeFileSync } from "node:fs";

/**
 * Record and report the outcome of a gate.
 *
 * @param {{failures: number, skipped?: boolean, skipReason?: string, counts?: object}} outcome
 * @returns {number} process exit code
 */
export function report(outcome) {
  const failures = Number.isFinite(outcome.failures) ? outcome.failures : 0;
  const skipped = outcome.skipped === true;
  const path = process.env.PAPER_TOOL_RESULT_FILE;
  if (typeof path === "string" && path !== "") {
    try {
      writeFileSync(
        path,
        JSON.stringify({ failures, skipped, skipReason: outcome.skipReason ?? null, counts: outcome.counts ?? null }),
        "utf8",
      );
    } catch {
      // A missing result file makes the runner fall back to the exit code, which
      // is still correct; it is not worth failing the gate over.
    }
  }
  return failures === 0 ? 0 : 1;
}

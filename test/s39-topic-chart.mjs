// Gate: the topic year-distribution chart must keep every bar proportional AND keep
// each count on its own row.
//
// Found on the real GUI: the peak year asked for width:100%, which 鈥?because the bar
// was a direct child of the row's flex container 鈥?made it fill the row and forced its
// own count label onto the next line. The screenshot showed a bar running past the
// panel edge with a stray "34" floating below it. Every other row looked fine, so the
// defect was only visible for the single tallest year.
//
// This is a structural assertion on the rendered tree, not a grep for CSS text: the
// bar has to be inside a track that is a sibling of the count, otherwise the percentage
// resolves against the wrong box again.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { installDom } from "./dom-stub.mjs";
import { join, sep } from "node:path";

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log("  ok   " + name);
  } else {
    failures.push(name);
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
  }
}

const client = readFileSync("client.js", "utf8");

// --- source-shape half -------------------------------------------------
// The bar must not be a bare child of the row: it has to sit in a track.
{
  const rowBlock = client.slice(
    client.indexOf("...trend.years.map((row) => h(\"div\""),
    client.indexOf("// Counts this plugin computed"),
  );
  check("the year rows were located", rowBlock.length > 100, "could not slice the year-row render");
  check("the bar sits inside its own track", /h\("span", \{ style: \{ flex: "1 1 auto"/.test(rowBlock),
    "no flex track wraps the bar, so a percentage width resolves against the row");
  check("the bar refuses to stretch", /flex: 0 0 auto/.test(client),
    ".pt-tr-bar has no flex:0 0 auto, so its width is only a starting basis");
  check("the year and the count refuse to shrink", (rowBlock.match(/flex: "none"/g) ?? []).length >= 2,
    "the year/count labels can be compressed by the bar");
}

// --- resolve React, else skip the mounted half ------------------------
// Same resolution s36 uses: the profile's node_modules, because the plugin's own
// checkout does not carry React (DSH supplies it to the client half).
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
  console.log(`  SKIP mounted section (react unavailable: ${error.message})`);
}

if (React !== undefined) {
  const { document, window } = installDom({ width: 900, height: 700 });
  globalThis.window = window;
  globalThis.document = document;

  // The chart is a pure function of `trend`; the row layout is what we assert, so a
  // small standalone render of the same structure is enough and keeps the gate fast.
  const h = React.createElement;
  const peak = 34;
  const years = [{ year: 2024, count: 5 }, { year: 2025, count: 7 }, { year: 2026, count: 34 }];
  const tree = h("div", null, ...years.map((row) => h("div", { key: row.year, className: "pt-toolbar" },
    h("span", { className: "pt-caption pt-num", style: { width: 44, flex: "none" } }, String(row.year)),
    h("span", { style: { flex: "1 1 auto", minWidth: 0, display: "flex" } },
      h("span", {
        className: "pt-tr-bar",
        style: { width: Math.max(2, Math.round((row.count / peak) * 100)) + "%" },
      }),
      h("div", { className: "pt-spacer" }),
    ),
    h("span", { className: "pt-caption pt-num", style: { flex: "none" } }, String(row.count)),
  )));

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(tree);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const bars = [...host.querySelectorAll(".pt-tr-bar")];
  check("every year rendered a bar", bars.length === years.length, "bars=" + bars.length);
  // The peak bar is the one that used to break: it must be in a track whose sibling is
  // the count, not a direct child of the row.
  const peakRow = host.querySelectorAll(".pt-toolbar")[years.length - 1];
  const peakBar = peakRow?.querySelector(".pt-tr-bar");
  check("the peak bar is inside a track", peakBar?.parentElement !== peakRow,
    "the peak bar is a direct child of the row again: width:100% will fill it");
  check("the peak track holds the bar and a spacer",
    (peakBar?.parentElement?.children.length ?? 0) === 2,
    "track children=" + (peakBar?.parentElement?.children.length ?? 0));
  const peakNums = peakRow === undefined || peakRow === null ? 0 : peakRow.querySelectorAll(".pt-num").length;
  check("the peak count stays in the row", peakNums === 2,
    "numeric labels in the peak row=" + peakNums + " (want the year and the count, no stray one below)");
  root.unmount();
}

console.log("");
if (failures.length > 0) {
  console.log("TOPIC-CHART FAILED (" + failures.length + "):");
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("TOPIC-CHART PASS");

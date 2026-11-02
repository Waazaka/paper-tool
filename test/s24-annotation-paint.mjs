// Reader annotation painting: the highlight has to actually become a <mark> in the
// text layer, and a drifted anchor has to be visible rather than silently missing.
//
// This tests the algorithm by exercising `paintHighlights` through the same client
// bundle the GUI loads, with a DOM stub standing in for the browser. It is not a
// pixel test (no layout engine) but it does catch the two failure modes that
// matter: a highlight that never gets painted, and a painter that destroys the
// text layer it is drawing on.
import { readFileSync } from "node:fs";
import { installDom } from "./dom-stub.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

// `paintHighlights` is defined inside the client bundle's closure, so the only
// honest way to test it is to evaluate the function as written. Extracting its
// source and building it here keeps the test tied to the shipped code instead of a
// re-implementation that could drift.
const source = readFileSync("client.js", "utf8");
const start = source.indexOf("function paintHighlights(");
if (start < 0) {
  console.log("  FAIL paintHighlights is not defined in client.js");
  process.exit(1);
}
// Walk braces to find the end of the function body.
let depth = 0;
let end = -1;
let seenOpen = false;
for (let i = start; i < source.length; i += 1) {
  const char = source[i];
  if (char === "{") {
    depth += 1;
    seenOpen = true;
  } else if (char === "}") {
    depth -= 1;
    if (seenOpen && depth === 0) {
      end = i + 1;
      break;
    }
  }
}
if (end < 0) {
  console.log("  FAIL could not find the end of paintHighlights");
  process.exit(1);
}
const paintSource = source.slice(start, end);

const dom = installDom();
const { document, NodeFilter } = dom;
// The painter calls createTreeWalker(container, NodeFilter.SHOW_TEXT) and
// document.createRange(); both are provided by the stub.
const factory = new Function(
  "document",
  "NodeFilter",
  `${paintSource}; return paintHighlights;`,
);
const paintHighlights = factory(document, NodeFilter);

// Build a text layer the way PDF.js does: one span per line, text nodes inside.
function makeLayer(lines) {
  const layer = document.createElement("div");
  for (const line of lines) {
    const span = document.createElement("span");
    span.appendChild(document.createTextNode(line));
    layer.appendChild(span);
  }
  return layer;
}

const QUOTE = "customer citizenship";

// --- 1. a matching quote becomes a <mark> --------------------------------
{
  const layer = makeLayer(["Servicescape shapes customer citizenship", "behaviour in hotels."]);
  const painted = paintHighlights(layer, [
    { annotationId: "a1", pageIndex: 0, quote: QUOTE, color: "yellow", note: "" },
  ]);
  check("a matching annotation is painted", painted === 1, String(painted));
  const marks = [...layer.allElements?.() ?? []].filter((el) => el.tagName === "MARK");
  // The stub exposes elements() as a generator; fall back to a manual walk if the
  // helper is absent so the assertion does not depend on stub internals.
  const found = marks.length > 0 ? marks : findAll(layer, "MARK");
  check("the mark element exists in the text layer", found.length === 1, String(found.length));
  if (found.length === 1) {
    check("the mark carries the annotation id", found[0].dataset.annotationId === "a1", found[0].dataset.annotationId);
    check("the mark carries the colour", found[0].dataset.color === "yellow");
    check("the mark wraps exactly the quoted text", found[0].textContent === QUOTE, JSON.stringify(found[0].textContent));
  }
}

// --- 2. a note becomes the mark's tooltip -------------------------------
{
  const layer = makeLayer(["Servicescape shapes customer citizenship here."]);
  paintHighlights(layer, [
    { annotationId: "a2", pageIndex: 0, quote: QUOTE, color: "green", note: "这是我自己的批注" },
  ]);
  const found = findAll(layer, "MARK");
  check("a note is attached as the mark title", found[0]?.title === "这是我自己的批注", found[0]?.title);
  check("the colour is preserved", found[0]?.dataset.color === "green", found[0]?.dataset.color);
}

// --- 3. whitespace differences do not defeat the match ------------------
{
  // The stored quote has single spaces; the page has line breaks and extra spaces,
  // which is the normal situation after PDF extraction.
  const layer = makeLayer(["Servicescape   shapes\ncustomer", "\tcitizenship  behaviour"]);
  const painted = paintHighlights(layer, [
    { annotationId: "a3", pageIndex: 0, quote: "Servicescape shapes customer citizenship" },
  ]);
  check("a quote matches across whitespace and line breaks", painted === 1, String(painted));
  // A cross-line quote cannot be one range (surroundContents refuses to wrap across
  // nodes), so it is painted as one mark per line it covers. Both parts must exist:
  // painting only the first line would silently shorten the highlight.
  const marks = findAll(layer, "MARK");
  check("a cross-line quote paints every line it covers", marks.length >= 2, String(marks.length));
  const paintedText = marks.map((m) => m.textContent).join("");
  check("the marks together cover the whole quote",
    paintedText.replace(/\s+/g, "") === "Servicescapeshapescustomercitizenship",
    JSON.stringify(paintedText));
}

// --- 4. a quote that is not on the page paints nothing ------------------
{
  const layer = makeLayer(["Completely unrelated text."]);
  const painted = paintHighlights(layer, [
    { annotationId: "a4", pageIndex: 0, quote: "this phrase is not here" },
  ]);
  check("a drifted anchor paints nothing", painted === 0, String(painted));
  check("a drifted anchor does not corrupt the text layer",
    layer.textContent === "Completely unrelated text.", layer.textContent);
}

// --- 5. the text layer survives painting intact ------------------------
{
  const original = ["Servicescape shapes customer citizenship", "behaviour in hotels."];
  const layer = makeLayer(original);
  const beforeText = layer.textContent;
  paintHighlights(layer, [{ annotationId: "a5", pageIndex: 0, quote: QUOTE }]);
  check("painting does not lose any text", layer.textContent === beforeText,
    `${JSON.stringify(beforeText)} -> ${JSON.stringify(layer.textContent)}`);
}

// --- 6. multiple annotations on one page all paint ---------------------
{
  const layer = makeLayer(["First highlighted phrase here.", "Second highlighted phrase there."]);
  const painted = paintHighlights(layer, [
    { annotationId: "m1", pageIndex: 0, quote: "First highlighted phrase" },
    { annotationId: "m2", pageIndex: 0, quote: "Second highlighted phrase" },
  ]);
  check("two annotations on one page both paint", painted === 2, String(painted));
  const found = findAll(layer, "MARK");
  check("both marks exist", found.length === 2, String(found.length));
  check("both phrases are still readable", layer.textContent.includes("First") && layer.textContent.includes("Second"));
}

// --- 7. an empty quote never paints (note-only annotations) ------------
{
  const layer = makeLayer(["Some text."]);
  const painted = paintHighlights(layer, [
    { annotationId: "n1", pageIndex: 0, quote: "", note: "整篇感想" },
  ]);
  check("a note-only annotation paints no mark", painted === 0, String(painted));

  // The dangerous case is not the empty quote on its own: `indexOf("")` returns 0,
  // so a painter that forgot to skip it would claim the *start of the page* and, more
  // importantly, could consume the region a real annotation needs. Put a real
  // annotation after the note-only one and require that only the real one paints.
  const mixed = makeLayer(["Servicescape shapes customer citizenship here."]);
  const paintedMixed = paintHighlights(mixed, [
    { annotationId: "note-only", pageIndex: 0, quote: "", note: "整篇感想" },
    { annotationId: "real", pageIndex: 0, quote: QUOTE },
  ]);
  check("a note-only annotation does not stop the real one from painting", paintedMixed === 1, String(paintedMixed));
  const mixedMarks = findAll(mixed, "MARK");
  check("only the real annotation produced a mark", mixedMarks.length === 1, String(mixedMarks.length));
  check("the mark belongs to the real annotation", mixedMarks[0]?.dataset.annotationId === "real", mixedMarks[0]?.dataset.annotationId);
  check("the note-only annotation did not hijack the page start",
    !mixedMarks.some((m) => m.textContent === "Some text."), JSON.stringify(mixedMarks.map((m) => m.textContent)));
}

// --- 8. no annotations is a no-op --------------------------------------
{
  const layer = makeLayer(["Some text."]);
  check("an empty list paints nothing", paintHighlights(layer, []) === 0);
  check("a missing list paints nothing", paintHighlights(layer, undefined) === 0);
  check("an empty layer paints nothing", paintHighlights(makeLayer([]), [{ annotationId: "x", quote: "y" }]) === 0);
}

// --- helpers ------------------------------------------------------------
function findAll(root, tagName) {
  const out = [];
  const visit = (node) => {
    if (node.tagName === tagName) out.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return out;
}

if (failures.length > 0) {
  console.log("\nANNOTATION-PAINT FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nANNOTATION-PAINT PASS");

// Interface gate: what the sidebar actually promises the user.
//
// ui-render.mjs proves every view renders. That is necessary but not sufficient:
// a view that renders but offers an unlabelled button, or a control with no
// keyboard path, is still broken for the person using it. Without a DOM
// (no jsdom, no network to install one) interaction cannot be clicked through,
// so this gate verifies the three things that are checkable statically and that
// real users actually hit:
//
//   1. ACCESSIBILITY  — every interactive element has an accessible name, and
//                       icon-only buttons are not left as bare glyphs.
//   2. STATE CLAIMS   — coverage/status wording can only claim what the data
//                       supports (no "full text" for an unread page, etc.).
//   3. HONESTY        — the UI never presents OCR text, a failed page, or a
//                       missing quote as if it were verified content.
//
// It reads client.js as source and also loads the real bundle to exercise the
// pure helpers. Run: node test/ui-a11y.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { report } from "./report.mjs";

const clientPath = join(process.cwd(), "client.js");
const source = readFileSync(clientPath, "utf8");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

console.log("Interface gate");

// --- 1. accessible names ------------------------------------------------
// An <button> wrapping only an icon or a bare glyph has no accessible name, so
// a screen-reader user hears "button". The Button component must therefore pass
// `label`/`title` whenever it takes `icon`.
check("icon buttons declare an accessible label", () => {
  const buttonDefs = [...source.matchAll(/h\(Button,\s*\{([^}]*)\}/gs)].map((m) => m[1]);
  assert.ok(buttonDefs.length > 0, "no Button usages found — the scan is wrong");
  const unnamed = buttonDefs.filter((props) => /\bicon\b/.test(props) && !/\blabel:/.test(props) && !/\btitle:/.test(props));
  assert.equal(
    unnamed.length,
    0,
    `${unnamed.length} icon button(s) without label/title: ${unnamed.map((p) => p.trim().slice(0, 60)).join(" | ")}`,
  );
});

check("Button forwards a label into aria-label for icon-only use", () => {
  // The component itself must convert label -> aria-label; otherwise an icon
  // button is silent even when the caller supplied a label.
  assert.ok(
    /"aria-label":\s*icon\s*&&\s*label\s*\?\s*label\s*:\s*undefined/.test(source),
    "Button no longer maps `label` to aria-label for icon buttons",
  );
});

check("every button element sets type=button", () => {
  // A <button> inside a form defaults to type=submit; the sidebar has no forms
  // today, but a future wrapper would turn "open paper" into "submit".
  const buttons = [...source.matchAll(/h\("button",\s*\{([^}]*)\}/gs)].map((m) => m[1]);
  const missing = buttons.filter((props) => !/type:\s*"button"/.test(props));
  assert.equal(missing.length, 0, `${missing.length} button(s) without type="button"`);
});

check("tabs expose their selected state", () => {
  assert.ok(/aria-selected/.test(source), "tab strip has no aria-selected — a screen reader cannot tell which view is open");
});

check("tabs are real buttons, not clickable divs", () => {
  // Clickable <div>s have no keyboard activation and no button role.
  const tabRender = source.slice(source.indexOf("setView(id)") - 600, source.indexOf("setView(id)") + 200);
  assert.ok(/h\("button"/.test(tabRender), "the tab strip does not use <button> elements");
});

// --- 2. state claims ----------------------------------------------------
// The tag that tells the user how much of a paper is readable drives what they
// trust. It must distinguish all three materials.
check("material badges cover text-layer, OCR and metadata-only", () => {
  for (const key of ["fulltext", "ocrText", "metaOnly"]) {
    assert.ok(new RegExp(`${key}:`).test(source), `dictionary key "${key}" is missing`);
  }
});

check("the OCR badge is not folded into either neighbour", () => {
  // A single ternary that only knows fulltext-vs-other would mislabel OCR.
  const card = source.slice(source.indexOf("function PaperCard"), source.indexOf("function PaperCard") + 2000);
  assert.ok(/paper\.material === "ocr"/.test(card), "PaperCard never checks for OCR material");
  assert.ok(/isOcr/.test(card), "PaperCard does not branch on the OCR state");
});

check("OCR badge carries an explanatory title", () => {
  // A badge that just says "scanned OCR" is not enough: the user needs to know
  // that individual characters may be wrong before quoting it in a review.
  //
  // Slice to the next component rather than a fixed byte count. A fixed window
  // silently stopped covering the badge once the card grew, so the gate failed for
  // a change that had not touched the badge at all — a false alarm that trains
  // people to ignore the gate.
  const start = source.indexOf("function PaperCard");
  assert.ok(start >= 0, "PaperCard is missing from client.js");
  const after = source.indexOf("function MetadataEditor", start);
  const card = source.slice(start, after > start ? after : start + 8000);
  assert.ok(/ocrHint/.test(card), "the OCR badge does not explain that characters may be wrong");
});

// --- 3. honesty -----------------------------------------------------------
check("an unlocated quote is not presented as located", () => {
  // charStart === -1 means "we could not find this quote on the page". Showing
  // a page-precise jump for that case would be a lie about precision.
  assert.ok(
    /charStart\s*(===|>=|>)\s*0|charStart\s*!==\s*-1|located/.test(source),
    "the UI does not branch on the -1 'unlocated' sentinel",
  );
});

check("an evidence quote from OCR is marked as such", () => {
  // EvidenceRow receives rows from listEvidence, which now carries the paper's
  // textSource. If the row drops that, a misread quote looks identical to a
  // verified one in the sidebar.
  const row = source.slice(source.indexOf("function EvidenceRow"), source.indexOf("function EvidenceRow") + 1600);
  assert.ok(/paperTextSource/.test(row), "EvidenceRow ignores paperTextSource");
  assert.ok(/fromOcr/.test(row), "EvidenceRow has no OCR branch");
  assert.ok(/ocrQuoteHint/.test(row), "EvidenceRow does not warn before citing an OCR quote");
  // Both dictionaries must define the warning (checked against the loaded bundle
  // further down, where DICTS is available).
  assert.ok(/ocrQuoteHint:\s*"/.test(source), "ocrQuoteHint is not defined in the dictionaries");
});

check("no view claims a result it did not compute", () => {
  // "not found" and "no evidence" are answers; rendering them as empty space
  // makes a failed search look like an absence of contrary evidence.
  for (const key of ["not_found", "no_evidence"]) {
    assert.ok(source.includes(key), `the UI has no wording for "${key}"`);
  }
});

check("snippets never become HTML", () => {
  assert.ok(!/dangerouslySetInnerHTML/.test(source), "client.js injects raw HTML");
});

// --- load the real bundle and exercise the pure helpers ----------------
const REACT_ROOT = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules");
const requireFromProfile = createRequire(join(REACT_ROOT, "noop.js"));
let React;
try {
  const domEntry = requireFromProfile.resolve("react-dom/server");
  const domRoot = domEntry.slice(0, domEntry.indexOf(`${sep}react-dom${sep}`));
  React = createRequire(join(domRoot, "noop.js"))("react");
} catch (error) {
  console.error(`UI-A11Y: react not resolvable: ${error.message}`);
  process.exit(2);
}
let exported = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      exported = factory((id) => {
        if (id === "react") return React;
        throw new Error(`unexpected require: ${id}`);
      });
    },
  },
};
globalThis.document = { querySelector: () => null, createElement: () => ({ style: {}, dataset: {} }), head: { appendChild() {} } };
await import(pathToFileURL(clientPath).href);
const { __test } = exported ?? {};
check("bundle exposes helpers for testing", () => {
  assert.ok(__test !== undefined, "no __test export");
  assert.equal(typeof __test.snippetNodes, "function");
});

const { snippetNodes, DICTS } = __test ?? {};

check("snippetNodes marks the hit without letting markup through", () => {
  const nodes = snippetNodes("a [b] c", "b", "t");
  assert.ok(Array.isArray(nodes) || nodes !== null, "snippetNodes returned nothing");
  const htmlish = JSON.stringify(nodes);
  assert.ok(!/<script|onerror=/i.test(htmlish), "snippet carried markup into the tree");
});

check("a snippet with unbalanced brackets still renders", () => {
  // Search snippets come from PDF text and can contain "[" or "]" naturally.
  for (const sample of ["[unclosed", "closed]", "a [b] [c]", "[]", "[[]]"]) {
    const nodes = snippetNodes(sample, "", "t");
    assert.ok(nodes !== null && nodes !== undefined, `snippet ${JSON.stringify(sample)} produced nothing`);
  }
});

check("both dictionaries are complete enough to render every label", () => {
  const required = ["fulltext", "ocrText", "ocrHint", "metaOnly", "noPdf", "pages"];
  // The metadata confidence badge is shown on the card, so its wording and the
  // per-field names must exist in both locales. A missing key here renders as the
  // raw key ("fieldVenue") on screen, which is worse than no badge at all.
  required.push("guessBadge", "guessHint", "fieldTitle", "fieldAuthors", "fieldYear", "fieldVenue", "fieldDoi", "listSep");
  for (const locale of ["zh", "en"]) {
    for (const key of required) {
      assert.equal(typeof DICTS[locale][key], "string", `${locale} is missing "${key}"`);
      assert.ok(DICTS[locale][key].length > 0, `${locale}.${key} is empty`);
    }
  }
});

check("the confidence badge marks guesses and only guesses", () => {
  // The badge exists so a guessed journal does not get cited as a fact. Two ways
  // to get it wrong, and both are worse than not showing it: marking XMP facts
  // (permanent noise the user learns to ignore) and failing to mark a layout guess
  // (a guess presented with the authority of publisher metadata).
  //
  // The client is a single module-loader factory with no exports, so the helper is
  // read out of the source and evaluated on its own. That keeps the gate honest:
  // it tests the function that actually ships, not a copy.
  const start = source.indexOf("function guessedFields");
  assert.ok(start >= 0, "guessedFields is missing from client.js");
  const end = source.indexOf("/** Dictionary key for a field name", start);
  assert.ok(end > start, "could not find the end of guessedFields");
  const guessedFields = new Function(`${source.slice(start, end)}\nreturn guessedFields;`)();

  // Publisher/XMP values: nothing to check.
  assert.deepEqual(
    guessedFields({ title: "T", authors: "A", venue: "V", year: "2021", doi: "d",
      metadataSource: '{"title":"xmp","authors":"xmp","venue":"subject","year":"subject","doi":"xmp"}' }),
    [],
    "publisher metadata was marked as a guess",
  );
  // Inference from layout or file name: mark exactly those fields.
  assert.deepEqual(
    guessedFields({ title: "T", authors: "A", venue: "V", year: "2021", doi: "",
      metadataSource: '{"title":"xmp","authors":"xmp","venue":"layout","year":"subject","doi":""}' }),
    ["venue"],
    "a guessed journal was not marked",
  );
  // A user correction removes its entry, so the field stops being marked.
  assert.deepEqual(
    guessedFields({ title: "T", authors: "A", venue: "V", year: "2021", doi: "d", metadataSource: "{}" }),
    [],
    "a verified paper is still marked",
  );
  // An empty field cannot be a wrong value, so it must not be marked either.
  assert.deepEqual(
    guessedFields({ title: "T", authors: "", venue: "", year: "", doi: "",
      metadataSource: '{"title":"layout","authors":"layout","venue":"layout","year":"layout","doi":""}' }),
    ["title"],
    "empty guessed fields were marked",
  );
  // Rows from before provenance was recorded, and corrupt JSON, must not pretend
  // to be verified OR spray warnings; both fall back to marking nothing.
  assert.deepEqual(guessedFields({ title: "T", authors: "A", metadataSource: "" }), [], "legacy row was marked");
  assert.deepEqual(guessedFields({ title: "T", authors: "A", metadataSource: "not json" }), [], "corrupt provenance was marked");
});

console.log(failures === 0 ? "\nUI-A11Y PASS" : `\n${failures} FAILURE(S)`);
process.exit(report({ failures }));

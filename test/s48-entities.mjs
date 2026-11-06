// Gate: text that came from the network is stored as text, not as markup.
//
// Found live, not by a gate: importing a PDF through the panel and reading the row
// showed the venue as `Journal of Destination Marketing &amp; Management`. That is
// Crossref's escaping, not the journal's name. It is a real user-visible defect — the
// venue is rendered in the row and printed into every citation, so a user would have
// exported a bibliography containing "&amp;".
//
// Crossref does not send plain text. `container-title` and `title` are HTML/JATS
// fragments, and abstracts carry `<jats:p>` tags. So every field this plugin takes from
// Crossref — in this module and in external-search — goes through `cleanRemoteText`.
//
// The hard part is the ORDER, and that is what most of this gate pins down:
//   1. strip tags while the markup is still literal `<i>`; decoding first turns `&lt;`
//      into a `<` and then eats text up to the next `>`, silently deleting real content.
//   2. decode entities exactly ONCE; repeating the pass keeps unwrapping `&amp;lt;` until
//      nothing is left.
// Those two mistakes produce plausible-looking output, so a test that only checks
// "&amp; became &" would pass on both of them. The cases below are chosen so it cannot.
import { parseCrossrefWork } from "../lib/metadata-enrich.js";
import { cleanRemoteText, decodeEntities } from "../lib/entities.js";
import { report } from "./report.mjs";

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else { console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail)); failures.push(name); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// --- 1. the live defect, verbatim ---------------------------------------
// The exact DOI and the exact string Crossref returned on 2026-11-06.
{
  const record = parseCrossrefWork({
    message: {
      DOI: "10.1016/j.jdmm.2020.100548",
      title: ["Host sincerity and tourist environmentally responsible behavior"],
      "container-title": ["Journal of Destination Marketing &amp; Management"],
      author: [{ family: "Li", given: "Shuhao" }],
      issued: { "date-parts": [[2021]] },
    },
  });
  eq("the live venue is decoded", record.venue, "Journal of Destination Marketing & Management");
  check("no entity survives in the venue", !/&[a-zA-Z]+;|&#\d+;/.test(record.venue), record.venue);
}

// --- 2. every Crossref field is cleaned, not just the venue ------------
{
  const record = parseCrossrefWork({
    message: {
      DOI: "10.1/x",
      title: ["The <i>E. coli</i> outbreak &amp; its aftermath"],
      "container-title": ["Journal of Things"],
      author: [{ family: "O&apos;Brien", given: "Ann" }, { family: "Smith", given: "J&amp;J" }],
      issued: { "date-parts": [[2020]] },
      publisher: "Elsevier &amp; Sons",
    },
  });
  eq("an italic tag is dropped from the title", record.title, "The E. coli outbreak & its aftermath");
  eq("an entity in an author name is decoded", record.authors, "O'Brien, Ann; Smith, J&J");
  eq("the publisher is decoded too", record.publisher, "Elsevier & Sons");
}

// --- 3. tag stripping must happen BEFORE decoding ----------------------
// Decoding first would turn `&lt;` into `<`, and the tag stripper would then treat
// "not italic" as markup and delete it. The correct answer keeps the words.
{
  eq("a literal &lt; is not mistaken for a tag",
    cleanRemoteText("a &lt;not italic&gt; phrase"), "a <not italic> phrase");
  check("and the words survive",
    cleanRemoteText("a &lt;not italic&gt; phrase").includes("not italic"),
    cleanRemoteText("a &lt;not italic&gt; phrase"));
}

// --- 4. decoding happens exactly once ----------------------------------
// A second pass would unwrap `&amp;lt;` again and eventually produce a character that
// was never in the record. One pass is the honest reading of the source.
{
  eq("double-escaped text decodes one level only", decodeEntities("&amp;lt;"), "&lt;");
  eq("triple-escaped text still decodes one level", decodeEntities("&amp;amp;lt;"), "&amp;lt;");
  eq("cleanRemoteText decodes one level", cleanRemoteText("&amp;lt;tag&amp;gt;"), "&lt;tag&gt;");
}

// --- 5. unknown and invalid entities are left alone --------------------
// Guessing is worse than failing loudly: `&foo;` in a stored value is visibly wrong and
// fixable, while a silently substituted character is neither.
{
  eq("an unknown named entity is preserved", decodeEntities("&nosuchentity;"), "&nosuchentity;");
  eq("a bare ampersand is preserved", decodeEntities("R&D"), "R&D");
  eq("an unterminated entity is preserved", decodeEntities("&amp"), "&amp");
  eq("code point 0 is not substituted", decodeEntities("&#0;"), "&#0;");
  eq("a surrogate code point is not substituted", decodeEntities("&#xD800;"), "&#xD800;");
  eq("an out-of-range code point is not substituted", decodeEntities("&#x110000;"), "&#x110000;");
  eq("a numeric entity just inside the range decodes",
    decodeEntities("&#x10FFFF;"), String.fromCodePoint(0x10ffff));
}

// --- 6. numeric entities in both bases ---------------------------------
{
  eq("decimal numeric entity", decodeEntities("&#38;"), "&");
  eq("hex numeric entity", decodeEntities("&#x26;"), "&");
  eq("uppercase hex prefix", decodeEntities("&#X26;"), "&");
  eq("en dash code point", decodeEntities("&#8211;"), "–");
  eq("em dash code point", decodeEntities("&#8212;"), "—");
}

// --- 7. whitespace and non-strings -------------------------------------
{
  eq("stripped tags do not leave a double space", cleanRemoteText("a <i>b</i> c"), "a b c");
  eq("newlines are collapsed", cleanRemoteText("a\n\n  b"), "a b");
  eq("nbsp becomes an ordinary space", cleanRemoteText("a&nbsp;b"), "a b");
  check("a non-breaking space entity does not survive as U+00A0",
    /\u00a0/.test(cleanRemoteText("a&nbsp;b")) === false,
    JSON.stringify(cleanRemoteText("a&nbsp;b")));
  eq("undefined becomes empty", cleanRemoteText(undefined), "");
  eq("null becomes empty", cleanRemoteText(null), "");
  eq("a number becomes its text", cleanRemoteText(42), "42");
  eq("leading and trailing space are trimmed", cleanRemoteText("  x  "), "x");
}

// --- 8. external-search cleans its candidates too ----------------------
// An external-search candidate is copied into the library by 加入, so the same escaping
// would end up in a stored row by a different route.
{
  const source = await import("node:fs").then(({ readFileSync }) =>
    readFileSync(new URL("../lib/external-search.js", import.meta.url), "utf8"));
  check("external-search imports the shared cleaner", /from "\.\/entities\.js"/.test(source));
  const venueLine = /venue: cleanRemoteText\(/.test(source);
  check("external-search cleans the venue", venueLine);
  const titleLine = /title: cleanRemoteText\(/.test(source);
  check("external-search cleans the title", titleLine);
  // The old code did its own ad-hoc tag stripping for abstracts; it must not still be
  // there, because two tag strippers drift and the ad-hoc one did not decode entities.
  check("the ad-hoc abstract stripper is gone", !/replace\(\/<\[\^>\]\+>\/g, " "\)/.test(source));
}

console.log("");
if (failures.length === 0) console.log("ENTITIES PASS");
else console.log(`ENTITIES FAIL (${failures.length}): ${failures.join("; ")}`);
process.exit(report({ failures: failures.length }));

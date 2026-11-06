// Text hygiene for bibliographic records fetched over the network.
//
// Crossref does not send plain text. `container-title` and `title` arrive as
// HTML/JATS fragments, so a perfectly ordinary journal name comes back as
//
//   "Journal of Destination Marketing &amp; Management"
//
// and a title with an italicised species name comes back as `The <i>E. coli</i>
// outbreak`. Storing either verbatim is a real defect, not a cosmetic one: the venue
// is rendered in the paper row and printed into every citation, so the user ends up
// with "&amp;" in their bibliography. Found live, by importing a PDF through the panel
// and reading the row: the venue showed `Journal of Destination Marketing &amp;
// Management`, which is Crossref's escaping, not the journal's name.
//
// Order matters here and is the whole reason this lives in one place:
//   1. strip tags FIRST, while the markup is still literal `<i>`. Decoding first would
//      turn `&lt;` into a `<` and then eat everything up to the next `>`, silently
//      deleting real text.
//   2. decode entities ONCE. A single pass means `&amp;lt;` becomes `&lt;` (correct: the
//      record really did contain the characters `&lt;`), where repeated passes would
//      keep unwrapping and eventually produce a `<` that was never in the data.
//   3. collapse whitespace, because stripped tags leave gaps behind.

const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  minus: "−",
};

/**
 * Decode HTML entities in one pass. Unknown entities are left exactly as they were:
 * guessing at an unrecognised name would corrupt the value, while leaving `&foo;` in
 * place is visibly wrong and therefore fixable.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function decodeEntities(value) {
  return String(value ?? "").replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.charAt(0) === "#") {
      const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Reject the ranges String.fromCodePoint throws on, and keep the original text
      // rather than substituting U+FFFD: an unrenderable entity is a data problem the
      // user should see, not something to paper over.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    const named = NAMED[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Turn a network-supplied title/venue/author value into the text a person should read:
 * tags dropped, entities decoded once, whitespace collapsed.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function cleanRemoteText(value) {
  const withoutTags = String(value ?? "").replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

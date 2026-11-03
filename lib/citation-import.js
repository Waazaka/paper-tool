// Import BibTeX and RIS files into the library as metadata-only papers.
//
// This is the shortest path for a user who already has a reference library: export
// from Zotero/EndNote/Mendeley, import the file here, get the entries into the
// library without re-adding them one by one. The entries carry no PDF, so they land
// as `material: "metadata"` and search will not pretend they have full text.
//
// Parsing is deliberately forgiving. Real .bib files in the wild are written by hand,
// by tools, and by tools that were fed hand-written files: braces nest, quotes
// delimit, macros exist, month fields are bare words. A parser that only accepts the
// clean subset it was tested on fails on the user's actual file, which is the only
// file that matters. What it must NOT do is invent: an entry that yields no title is
// reported as unreadable rather than turned into a paper called "".

const MONTHS = new Map([
  ["jan", "01"], ["feb", "02"], ["mar", "03"], ["apr", "04"],
  ["may", "05"], ["jun", "06"], ["jul", "07"], ["aug", "08"],
  ["sep", "09"], ["oct", "10"], ["nov", "11"], ["dec", "12"],
]);

/** Split on a delimiter that is not inside braces or quotes. */
function splitTopLevel(text, delimiter) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") { i += 1; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === '"' && depth === 0) quoted = !quoted;
    else if (char === delimiter && depth === 0 && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Strip one layer of braces or quotes, and \LaTeX\ escapes that are safe to drop. */
function unquote(value) {
  let out = String(value ?? "").trim();
  // A field may be wrapped once in braces or quotes; inner braces are content that
  // protects case (e.g. {DNA}) and are removed without touching the letters.
  if (out.startsWith("{") && out.endsWith("}")) out = out.slice(1, -1);
  else if (out.startsWith('"') && out.endsWith('"')) out = out.slice(1, -1);
  out = out
    .replace(/\\textbackslash\{\}/g, "\\")
    .replace(/\\([&%$#_{}])/g, "$1")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

/** "Smith, John and Doe, Jane" -> "John Smith; Jane Doe" (the library's separator). */
function parseAuthors(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return "";
  return text
    .split(/\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.includes(",")) {
        const [family, ...rest] = part.split(",").map((piece) => piece.trim());
        const given = rest.join(" ").trim();
        return given === "" ? family : `${given} ${family}`;
      }
      return part;
    })
    .join("; ");
}

/**
 * Parse a BibTeX file into candidate records.
 *
 * @param {string} text
 * @returns {{records: object[], skipped: object[]}}
 */
export function parseBibtex(text) {
  const source = String(text ?? "");
  const records = [];
  const skipped = [];
  const entryPattern = /@([a-zA-Z]+)\s*([{(])/g;
  let match = entryPattern.exec(source);
  while (match !== null) {
    const entryType = match[1].toLowerCase();
    // Skip the two pseudo-entries that are not bibliographic records.
    if (entryType === "comment" || entryType === "preamble" || entryType === "string") {
      match = entryPattern.exec(source);
      continue;
    }
    const openIndex = match.index + match[0].length;
    const closeChar = match[2] === "{" ? "}" : ")";
    // Walk to the matching close, counting braces so a field value containing a brace
    // does not end the entry early.
    let depth = 1;
    let i = openIndex;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (char === "\\") { i += 1; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
      } else if (char === closeChar && depth === 1 && match[2] === "(") {
        break;
      }
    }
    const body = source.slice(openIndex, i);
    const commaAt = body.indexOf(",");
    if (commaAt < 0) {
      skipped.push({ reason: "entry has no fields", raw: body.slice(0, 80) });
      match = entryPattern.exec(source);
      continue;
    }
    const key = body.slice(0, commaAt).trim();
    const fields = {};
    for (const chunk of splitTopLevel(body.slice(commaAt + 1), ",")) {
      const eq = chunk.indexOf("=");
      if (eq < 0) continue;
      const name = chunk.slice(0, eq).trim().toLowerCase();
      const value = chunk.slice(eq + 1).trim();
      if (name !== "") fields[name] = value;
    }
    const title = unquote(fields.title);
    if (title === "") {
      skipped.push({ reason: "entry has no title", key });
      match = entryPattern.exec(source);
      continue;
    }
    let year = unquote(fields.year ?? fields.date ?? "");
    year = /\d{4}/.exec(year)?.[0] ?? "";
    let venue = unquote(fields.journal ?? fields.booktitle ?? fields.journaltitle ?? fields.publisher ?? fields.school ?? "");
    // A bare month macro is a month, not a venue or a title fragment.
    if (venue !== "" && MONTHS.has(venue.toLowerCase()) && fields.journal === undefined && fields.booktitle === undefined) {
      venue = "";
    }
    records.push({
      title,
      authors: parseAuthors(unquote(fields.author ?? fields.editor ?? "")),
      year,
      venue,
      doi: normalizeDoi(unquote(fields.doi ?? "")),
      abstract: unquote(fields.abstract ?? ""),
      entryType,
      citeKey: key,
      source: "bibtex",
    });
    match = entryPattern.exec(source);
  }
  return { records, skipped };
}

/** "doi:10.1/x", "https://doi.org/10.1/X" -> "10.1/x" */
export function normalizeDoi(value) {
  let doi = String(value ?? "").trim();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  doi = doi.replace(/^doi:\s*/i, "");
  return doi.trim().toLowerCase();
}

const RIS_TYPE = new Map([
  ["JOUR", "article"], ["EJOUR", "article"], ["MGZN", "article"], ["NEWS", "article"],
  ["BOOK", "book"], ["CHAP", "chapter"], ["CONF", "inproceedings"], ["CPAPER", "inproceedings"],
  ["THES", "thesis"], ["RPRT", "techreport"], ["UNPB", "misc"],
]);

/**
 * Parse an RIS file into candidate records.
 *
 * RIS is line-oriented: `TAG  - value`, one field per line, records separated by
 * `ER  - `. Continuation lines (a value wrapped over several lines) are indented;
 * their content is appended to the previous field.
 *
 * @param {string} text
 * @returns {{records: object[], skipped: object[]}}
 */
export function parseRis(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const records = [];
  const skipped = [];
  let current = null;
  let lastTag = null;
  const flush = () => {
    if (current === null) return;
    const title = (current.T1 ?? current.TI ?? "").trim();
    if (title === "") {
      skipped.push({ reason: "record has no title", type: current.TY ?? "" });
      current = null;
      lastTag = null;
      return;
    }
    const authors = [current.AU, current.A1]
      .filter(Boolean)
      .flatMap((value) => value.split(/\r?\n/))
      .map((part) => part.trim())
      .filter(Boolean)
      // RIS writes "Family, Given"; the library stores "Given Family". Normalising here
      // keeps a .ris import and a .bib import of the same paper identical in the table,
      // which is what the round-trip check compares.
      .map((part) => {
        if (!part.includes(",")) return part;
        const [family, ...rest] = part.split(",").map((piece) => piece.trim());
        const given = rest.join(" ").trim();
        return given === "" ? family : `${given} ${family}`;
      })
      .join("; ");
    const year = /\d{4}/.exec(current.PY ?? current.Y1 ?? "")?.[0] ?? "";
    records.push({
      title,
      authors,
      year,
      venue: (current.JO ?? current.JF ?? current.T2 ?? current.PB ?? "").trim(),
      doi: normalizeDoi(current.DO ?? ""),
      abstract: (current.AB ?? current.N2 ?? "").trim(),
      entryType: RIS_TYPE.get(String(current.TY ?? "").trim().toUpperCase()) ?? "misc",
      source: "ris",
    });
    current = null;
    lastTag = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const tagged = /^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/.exec(line);
    if (tagged === null) {
      // A continuation of the previous value (RIS wraps long titles this way).
      if (current !== null && lastTag !== null && /^\s+/.test(raw)) {
        current[lastTag] = `${current[lastTag]} ${line.trim()}`;
      }
      continue;
    }
    const tag = tagged[1];
    const value = tagged[2];
    if (tag === "TY") {
      flush();
      current = { TY: value.trim() };
      lastTag = "TY";
      continue;
    }
    if (tag === "ER") { flush(); continue; }
    if (current === null) continue;
    // AU and A1 repeat once per author; joining with a newline lets authors be split
    // later without losing the boundary between two names.
    if ((tag === "AU" || tag === "A1") && current[tag] !== undefined) {
      current[tag] = `${current[tag]}\n${value}`;
    } else if (current[tag] === undefined) {
      current[tag] = value;
    } else {
      current[tag] = `${current[tag]} ${value}`;
    }
    lastTag = tag;
  }
  flush();
  return { records, skipped };
}

/** Pick the parser from the file name, then from the content. */
export function detectFormat(fileName, text) {
  const name = String(fileName ?? "").toLowerCase();
  if (name.endsWith(".bib") || name.endsWith(".bibtex")) return "bibtex";
  if (name.endsWith(".ris")) return "ris";
  const source = String(text ?? "");
  if (/^\s*@\s*[a-zA-Z]+\s*[{(]/m.test(source)) return "bibtex";
  if (/^\s*TY\s{1,2}-\s/m.test(source)) return "ris";
  return "";
}

/**
 * Parse a citation file. Unknown formats are reported, never guessed at.
 *
 * @param {{fileName?: string, text: string}} input
 * @returns {{format: string, records: object[], skipped: object[]}}
 */
export function parseCitationFile({ fileName = "", text = "" } = {}) {
  const format = detectFormat(fileName, text);
  if (format === "") {
    return { format: "", records: [], skipped: [{ reason: "unrecognised citation file format" }] };
  }
  const parsed = format === "bibtex" ? parseBibtex(text) : parseRis(text);
  return { format, records: parsed.records, skipped: parsed.skipped };
}

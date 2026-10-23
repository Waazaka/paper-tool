// BibTeX export from stored metadata only.
//
// No citations are invented here: each entry is a library paper the caller
// already selected. Keys are deterministic for the same input so repeated
// exports do not churn a .bib file.
import { toCslItem } from "./citeproc.js";

const RESERVED = new Set([
  "and", "of", "the", "a", "an", "on", "in", "for", "to", "with", "from",
]);

function asciiSlug(value, fallback) {
  const plain = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
  return plain === "" ? fallback : plain;
}

function firstAuthorFamily(paper) {
  const csl = toCslItem(paper);
  const first = Array.isArray(csl.author) ? csl.author[0] : null;
  if (first === null) return "anon";
  if (first.family) return first.family;
  if (first.literal) return String(first.literal).split(/[\s,]+/).filter(Boolean).pop() ?? "anon";
  return "anon";
}

function firstTitleWord(paper) {
  const words = String(paper.title ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const meaningful = words.find((word) => !RESERVED.has(word.toLowerCase()));
  return meaningful ?? words[0] ?? "paper";
}

function yearOf(paper) {
  return /\d{4}/.exec(String(paper.year ?? ""))?.[0] ?? "nd";
}

/**
 * Stable, collision-free citation keys: family + year + title word, suffix
 * a/b/c for real collisions. Chinese names keep their characters when present
 * (BibTeX accepts UTF-8 keys in practice); otherwise the key is ASCII.
 */
export function makeCiteKeys(papers) {
  const used = new Map();
  const keys = new Map();
  for (const paper of papers) {
    const family = asciiSlug(firstAuthorFamily(paper), "");
    const word = asciiSlug(firstTitleWord(paper), "paper").slice(0, 16);
    const base = `${family || "paper"}${yearOf(paper)}${word.toLowerCase()}`.slice(0, 40);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    keys.set(paper.paperId, count === 1 ? base : `${base}${String.fromCharCode(96 + count)}`);
  }
  return keys;
}

function escapeField(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\\{}&%$#_]/g, (char) => (char === "\\" ? "\\textbackslash{}" : `\\${char}`))
    .trim();
}

function authorField(paper) {
  const csl = toCslItem(paper);
  if (!Array.isArray(csl.author) || csl.author.length === 0) return "";
  return csl.author
    .map((author) => {
      if (author.family) {
        return author.given ? `${author.family}, ${author.given}` : author.family;
      }
      return author.literal ?? "";
    })
    .filter(Boolean)
    .join(" and ");
}

function entryFor(paper, key) {
  const authors = authorField(paper);
  const fields = [
    ["title", paper.title],
    ["author", authors],
    ["year", yearOf(paper) === "nd" ? "" : yearOf(paper)],
    paper.venue ? ["journal", paper.venue] : null,
    paper.doi ? ["doi", paper.doi] : null,
    paper.paperId ? ["note", `paper-tool:${paper.paperId}`] : null,
  ].filter(Boolean);

  const body = fields
    .filter(([, value]) => String(value ?? "").trim() !== "")
    .map(([name, value]) => `  ${name} = {${escapeField(value)}},`)
    .join("\n");

  return `@misc{${key},\n${body}\n}`;
}

/** Render a complete .bib from papers, with the key map alongside it. */
export function renderBibtex(papers) {
  const keys = makeCiteKeys(papers);
  const entries = papers
    .map((paper) => entryFor(paper, keys.get(paper.paperId)))
    .filter(Boolean);
  return {
    bibtex: entries.join("\n\n"),
    keys: [...keys.entries()].map(([paperId, key]) => ({ paperId, key })),
  };
}

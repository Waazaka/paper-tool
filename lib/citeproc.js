// Citation formatting (S4) — the reuse the plan measured first.
//
// `citeproc` is a pure-JS CSL processor (verified: it rendered APA and IEEE
// bibliography and in-text citations from real item data before any of this
// was written). Writing a formatter by hand would be a second, worse
// implementation of a solved problem.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * This package's own `styles/` directory.
 *
 * Found by walking up from this module to the package root, because the module
 * runs from `lib/` in DSH but from a generated test directory under the same
 * package during tests. A relative path would only work in one of them.
 */
function stylesDir() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "styles", "locales-en-US.xml"))) return join(dir, "styles");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dirname(fileURLToPath(import.meta.url)), "..", "styles");
}

/** Optional extra style directories outside this package. */
const EXTRA_STYLE_DIRS = [join(process.env.USERPROFILE ?? "", "Zotero", "styles")].filter(Boolean);

let citeprocModule = null;
function loadCiteproc() {
  if (citeprocModule === null) citeprocModule = require("citeproc");
  return citeprocModule;
}

/** Map an internal style id to the CSL XML we can actually read. */
const BUILTIN_FALLBACK = {
  apa: "apa",
  ieee: "ieee",
  "chicago-author-date": "chicago-author-date",
  mla: "modern-language-association",
  "gb-t-7714": "china-national-standard-gb-t-7714-2015-numeric",
  "gb-t-7714-author-date": "china-national-standard-gb-t-7714-2015-author-date",
  harvard: "harvard-cite-them-right",
  nature: "nature",
};

export const DEFAULT_STYLES = Object.keys(BUILTIN_FALLBACK);

/** Locate a CSL file on disk for a style id; returns null when unavailable. */
async function findStyleFile(styleId) {
  const candidates = [styleId, BUILTIN_FALLBACK[styleId]].filter(Boolean);
  for (const dir of [stylesDir(), ...EXTRA_STYLE_DIRS]) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      const name = candidate.endsWith(".csl") ? candidate : `${candidate}.csl`;
      if (entries.includes(name)) return join(dir, name);
    }
  }
  return null;
}

/** Which styles are usable right now, for honest UI listing. */
export async function availableStyles() {
  const found = [];
  for (const styleId of DEFAULT_STYLES) {
    if ((await findStyleFile(styleId)) !== null) found.push(styleId);
  }
  return found;
}

/** Build a CSL item from a stored paper + its metadata. */
export function toCslItem(paper) {
  // Author separators are ambiguous ("Li, Shuhao; Wei, Min" separates people
  // with ';' but names with ','). Prefer the explicit separators so a
  // "Family, Given" pair never splits into two people.
  const raw = String(paper.authors ?? "").trim();
  const parts = raw === ""
    ? []
    : raw.includes(";")
      ? raw.split(";")
      : /\s+and\s+/i.test(raw)
        ? raw.split(/\s+and\s+/i)
        : [raw];
  const authors = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((name) => {
      if (name.includes(",")) {
        const [family, ...rest] = name.split(",");
        return { family: family.trim(), given: rest.join(",").trim() };
      }
      return { literal: name };
    });
  const issuedYear = /\d{4}/.exec(String(paper.year ?? ""))?.[0];
  return {
    id: paper.paperId,
    type: "article-journal",
    title: paper.title || "(untitled)",
    ...(authors.length > 0 ? { author: authors } : {}),
    ...(paper.venue ? { "container-title": paper.venue } : {}),
    ...(issuedYear ? { issued: { "date-parts": [[Number(issuedYear)]] } } : {}),
    ...(paper.doi ? { DOI: paper.doi } : {}),
  };
}

/**
 * Render a bibliography and the matching in-text cluster.
 *
 * @param {object[]} papers stored paper rows
 * @param {string} styleId requested style
 * @param {string} [locale] CSL locale id, default en-US
 * @returns {Promise<{ok: boolean, styleId: string, styleFile: string|null, bibliography: string, citation: string, reason?: string}>}
 */
export async function renderBibliography(papers, styleId, locale = "en-US") {
  const styleFile = await findStyleFile(styleId);
  if (styleFile === null) {
    return {
      ok: false,
      styleId,
      styleFile: null,
      bibliography: "",
      citation: "",
      reason: `style "${styleId}" is not installed on this machine`,
    };
  }
  const styleXml = await readFile(styleFile, "utf8");
  const localeXml = await readLocale(locale);
  const CSL = loadCiteproc();
  const items = {};
  for (const paper of papers) {
    const item = toCslItem(paper);
    items[item.id] = item;
  }
  const ids = Object.keys(items);
  if (ids.length === 0) {
    return { ok: true, styleId, styleFile, bibliography: "", citation: "" };
  }
  const sys = {
    retainLocale: true,
    // The processor needs the full locale term set; a partial one crashes on
    // date formatting (measured), so a real locale file is required.
    retrieveLocale: (lang) => (lang === locale ? localeXml : localeXml),
    retrieveItem: (id) => items[id],
    retrieveStyle: () => undefined,
  };
  const engine = new CSL.Engine(sys, styleXml, locale);
  engine.updateItems(ids);
  const bib = engine.makeBibliography();
  const bibliography = Array.isArray(bib?.[1])
    ? bib[1].map((entry) => stripTags(String(entry)).trim()).filter(Boolean).join("\n")
    : "";
  const citation = stripTags(engine.makeCitationCluster(ids.map((id) => ({ id }))) ?? "");
  return { ok: true, styleId, styleFile, bibliography, citation };
}

/** Load a CSL locale XML from this package's vendored styles directory. */
async function readLocale(locale) {
  const dir = stylesDir();
  for (const candidate of [`locales-${locale}.xml`, "locales-en-US.xml"]) {
    try {
      return await readFile(join(dir, candidate), "utf8");
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`CSL locale ${locale} is not bundled`);
}

/** CSL output is HTML-ish; convert the common entities and drop tags. */
function stripTags(text) {
  return String(text)
    .replace(/<i>/g, "")
    .replace(/<\/i>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#38;/g, "&")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/<[^>]+>/g, "");
}

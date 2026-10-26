// External metadata search (S6).
//
// Pulls candidate papers into the library from free, keyless APIs. No scraping,
// no API keys, no accounts:
//   - OpenAlex    : broad, has abstracts, good for citation counts
//   - Crossref    : authoritative DOIs and venue names
//   - arXiv       : preprints with direct PDF links
//
// Network failures degrade to an empty result with a reason, never a throw that
// kills a turn: a search outage must not look like "no papers exist".
import { randomUUID } from "node:crypto";

const UA = "paper-tool/0.1 (DSH plugin; local paper workbench)";
const TIMEOUT_MS = 12_000;

/** Sources we can query, in the order we try them. */
export const SOURCES = ["openalex", "crossref", "arxiv"];

async function fetchJson(url, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const composite = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: composite,
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "timed out" : (error?.message ?? String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAlex: invert the abstract index into plain text. */
function openAlexAbstract(inverted) {
  if (typeof inverted !== "object" || inverted === null) return "";
  // Bounded both ways: a sparse array sized by the largest position costs
  // time proportional to that position, and this is remote data. 20k words is
  // far past any real abstract, so anything beyond it is not an abstract.
  const MAX_POSITION = 20000;
  const slots = [];
  let highest = -1;
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0 || position >= MAX_POSITION) continue;
      slots[position] = word;
      if (position > highest) highest = position;
    }
  }
  if (highest < 0) return "";
  const out = [];
  for (let index = 0; index <= highest; index += 1) {
    const word = slots[index];
    if (typeof word === "string") out.push(word);
    if (out.length >= 400) break;
  }
  return out.join(" ").slice(0, 2000);
}

function cleanDoi(doi) {
  return String(doi ?? "").replace(/^https?:\/\/doi\.org\//i, "").trim();
}

async function searchOpenAlex(query, limit, signal) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}&mailto=paper-tool@example.invalid`;
  const response = await fetchJson(url, signal);
  if (!response.ok) return { source: "openalex", ok: false, reason: response.reason, candidates: [] };
  const results = Array.isArray(response.value?.results) ? response.value.results : [];
  const candidates = results.map((work) => {
    const authors = Array.isArray(work.authorships)
      ? work.authorships
          .map((entry) => entry?.author?.display_name)
          .filter((name) => typeof name === "string")
          .join("; ")
      : "";
    return {
      title: String(work.title ?? work.display_name ?? "").trim(),
      authors,
      year: work.publication_year === undefined || work.publication_year === null ? "" : String(work.publication_year),
      venue: String(work.primary_location?.source?.display_name ?? "").trim(),
      doi: cleanDoi(work.doi),
      abstract: openAlexAbstract(work.abstract_inverted_index),
      url: String(work.id ?? ""),
      citations: typeof work.cited_by_count === "number" ? work.cited_by_count : 0,
      openAccess: Boolean(work.open_access?.is_oa),
      pdfUrl: String(work.best_oa_location?.pdf_url ?? work.primary_location?.pdf_url ?? ""),
      source: "openalex",
    };
  });
  return { source: "openalex", ok: true, candidates: candidates.filter((item) => item.title !== "") };
}

async function searchCrossref(query, limit, signal) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&select=DOI,title,author,issued,container-title,abstract,is-referenced-by-count,URL`;
  const response = await fetchJson(url, signal);
  if (!response.ok) return { source: "crossref", ok: false, reason: response.reason, candidates: [] };
  const items = Array.isArray(response.value?.message?.items) ? response.value.message.items : [];
  const candidates = items.map((item) => {
    const authors = Array.isArray(item.author)
      ? item.author
          .map((person) => [person?.family, person?.given].filter(Boolean).join(", "))
          .filter((name) => name !== "")
          .join("; ")
      : "";
    const issued = item.issued?.["date-parts"]?.[0]?.[0];
    // Crossref abstracts carry JATS tags.
    const abstract = String(item.abstract ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
    return {
      title: Array.isArray(item.title) ? String(item.title[0] ?? "").trim() : String(item.title ?? "").trim(),
      authors,
      year: issued === undefined ? "" : String(issued),
      venue: Array.isArray(item["container-title"]) ? String(item["container-title"][0] ?? "").trim() : "",
      doi: cleanDoi(item.DOI),
      abstract,
      url: String(item.URL ?? ""),
      citations: typeof item["is-referenced-by-count"] === "number" ? item["is-referenced-by-count"] : 0,
      openAccess: false,
      pdfUrl: "",
      source: "crossref",
    };
  });
  return { source: "crossref", ok: true, candidates: candidates.filter((item) => item.title !== "") };
}

/** arXiv returns Atom XML; parse the handful of fields we need without a dep. */
function parseArxivXml(xml, limit) {
  const entries = xml.split(/<entry>/).slice(1);
  const candidates = [];
  for (const entry of entries.slice(0, limit)) {
    const pick = (tag) => {
      const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
      return match === null ? "" : match[1].trim();
    };
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((match) => match[1].trim()).join("; ");
    const pdfUrl = (/<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(entry) ?? [])[1] ?? "";
    const published = pick("published");
    candidates.push({
      title: pick("title").replace(/\s+/g, " "),
      authors,
      year: published.slice(0, 4),
      venue: "arXiv",
      doi: cleanDoi(pick("doi")),
      abstract: pick("summary").replace(/\s+/g, " ").slice(0, 2000),
      url: pick("id"),
      citations: 0,
      openAccess: true,
      pdfUrl,
      source: "arxiv",
    });
  }
  return candidates.filter((item) => item.title !== "");
}

async function searchArxiv(query, limit, signal) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const composite = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  try {
    const response = await fetch(url, { headers: { "user-agent": UA }, signal: composite });
    if (!response.ok) return { source: "arxiv", ok: false, reason: `HTTP ${response.status}`, candidates: [] };
    const xml = await response.text();
    return { source: "arxiv", ok: true, candidates: parseArxivXml(xml, limit) };
  } catch (error) {
    return {
      source: "arxiv",
      ok: false,
      reason: error?.name === "AbortError" ? "timed out" : (error?.message ?? String(error)),
      candidates: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query one or more sources and merge the candidates.
 *
 * Duplicates are collapsed by DOI and then by normalised title, because the
 * same paper is routinely returned by two sources with different rankings.
 *
 * @param {string} query
 * @param {{limit?: number, sources?: string[], signal?: AbortSignal}} options
 */
export async function searchExternal(query, options = {}) {
  const text = String(query ?? "").trim();
  if (text === "") return { query: "", candidates: [], sources: [], failures: [] };
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  const wanted = Array.isArray(options.sources) && options.sources.length > 0
    ? options.sources.filter((source) => SOURCES.includes(source))
    : SOURCES;
  const runners = { openalex: searchOpenAlex, crossref: searchCrossref, arxiv: searchArxiv };

  // Sequential with a per-source budget: three parallel requests from one
  // plugin is a good way to get rate-limited by all three.
  const results = [];
  const failures = [];
  for (const source of wanted) {
    const result = await runners[source](text, limit, options.signal);
    results.push(result);
    if (!result.ok) failures.push({ source, reason: result.reason });
  }

  const seenDoi = new Set();
  const seenTitle = new Set();
  const merged = [];
  for (const result of results) {
    for (const candidate of result.candidates) {
      const doiKey = candidate.doi.toLowerCase();
      const titleKey = candidate.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "").slice(0, 80);
      if (doiKey !== "" && seenDoi.has(doiKey)) continue;
      if (titleKey !== "" && seenTitle.has(titleKey)) continue;
      if (doiKey !== "") seenDoi.add(doiKey);
      if (titleKey !== "") seenTitle.add(titleKey);
      merged.push(candidate);
    }
  }
  return { query: text, candidates: merged.slice(0, limit * wanted.length), sources: wanted, failures };
}

/**
 * Import external candidates into the library as metadata-only rows.
 *
 * They are stored without a PDF on purpose: the full text is not available, so
 * `material` stays "metadata" and search will not pretend otherwise.
 *
 * A DOI already in the library is the same work, so re-adding a candidate
 * returns the existing row instead of producing a second bibliography entry
 * for it.
 */
export function importCandidates(store, candidates) {
  const imported = [];
  const duplicates = [];
  for (const candidate of candidates) {
    const doi = String(candidate.doi ?? "").trim();
    if (doi !== "") {
      const existing = store.findByDoi(doi);
      if (existing !== null) {
        duplicates.push({ paperId: existing.paperId, title: existing.title, doi });
        continue;
      }
    }
    const paperId = randomUUID();
    const paper = store.upsertPaper({
      paperId,
      title: candidate.title,
      authors: candidate.authors ?? "",
      year: candidate.year ?? "",
      venue: candidate.venue ?? "",
      doi,
      abstract: candidate.abstract ?? "",
      source: candidate.source ?? "external",
      pdfPath: "",
      fingerprint: "",
      material: "metadata",
      pages: [],
    });
    imported.push({ paperId: paper.paperId, title: paper.title, source: candidate.source, doi: paper.doi });
  }
  return { imported, duplicates };
}

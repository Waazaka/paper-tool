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
import { cleanRemoteText } from "./entities.js";

const UA = "paper-tool/0.1 (DSH plugin; local paper workbench)";
const TIMEOUT_MS = 12_000;

/**
 * Sources we can query, in the order we try them.
 *
 * Ordered by expected value for this tool's actual corpus (tourism/hospitality management
 * and Chinese LIS), not by the order the planning document lists them: OpenAlex has the
 * best citation coverage, Semantic Scholar adds influential-citation counts, Crossref is
 * the DOI authority, arXiv carries preprints, and PubMed is biomedical — included because
 * the plan names it, but it will return nothing for most queries in this library.
 *
 * This order only decides *which* source is asked first; it no longer decides the order
 * of the results (see `mergeCandidates`).
 */
export const SOURCES = ["openalex", "crossref", "arxiv", "semanticscholar", "pubmed"];

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
    // Distinguish the user cancelling from our own timeout. Both surface as an
    // AbortError on this signal, because `composite` merges the two controllers — but
    // they mean opposite things: a timeout is a failed source, a cancellation means
    // the user wants nothing at all. Reporting the second as "timed out" would put a
    // false diagnostic in front of someone who simply changed their mind.
    if (signal?.aborted === true) throw error;
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
      citationsKnown: typeof work.cited_by_count === "number",
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
    // Crossref abstracts carry JATS tags, and every text field carries HTML entities.
    // The venue for 10.1016/j.jdmm.2020.100548 arrives as "Journal of Destination
    // Marketing &amp; Management"; worth decoding here too, because an external-search
    // candidate is copied into the library by 加入 and would otherwise carry the
    // escaping into the stored row.
    const abstract = cleanRemoteText(item.abstract ?? "").slice(0, 2000);
    return {
      title: cleanRemoteText(Array.isArray(item.title) ? item.title[0] ?? "" : item.title ?? ""),
      authors,
      year: issued === undefined ? "" : String(issued),
      venue: cleanRemoteText(Array.isArray(item["container-title"]) ? item["container-title"][0] ?? "" : ""),
      doi: cleanDoi(item.DOI),
      abstract,
      url: String(item.URL ?? ""),
      citations: typeof item["is-referenced-by-count"] === "number" ? item["is-referenced-by-count"] : 0,
      // Crossref's count is real but lags behind publication; still a known number.
      citationsKnown: typeof item["is-referenced-by-count"] === "number",
      openAccess: false,
      pdfUrl: "",
      source: "crossref",
    };
  });
  return { source: "crossref", ok: true, candidates: candidates.filter((item) => item.title !== "") };
}

/** Attributes of one XML start tag, in whatever order the feed happens to send them. */
function tagAttributes(startTag) {
  const attributes = {};
  for (const match of startTag.matchAll(/([\w:.-]+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

/**
 * The published DOI of one arXiv entry.
 *
 * arXiv does not use Atom's own `<doi>` element: it announces the DOI as the namespaced
 * `<arxiv:doi>`. Matching the bare tag name therefore matched nothing, and every preprint
 * was imported DOI-less — so a paper that arXiv says is the same work as a journal article
 * was added twice, and the duplicate check had nothing to compare.
 *
 * The same value is repeated as `<link rel="related" href="https://doi.org/..." title="doi"/>`,
 * which is the fallback if a feed ever drops the namespace.
 */
function arxivDoi(entry) {
  const element = /<(?:arxiv:)?doi\b[^>]*>([\s\S]*?)<\/(?:arxiv:)?doi>/.exec(entry);
  if (element !== null) {
    const doi = cleanDoi(element[1]);
    if (doi !== "") return doi;
  }
  for (const match of entry.matchAll(/<link\b[^>]*>/g)) {
    const attributes = tagAttributes(match[0]);
    if (attributes.title !== "doi" && !/^https?:\/\/doi\.org\//i.test(attributes.href ?? "")) continue;
    const doi = cleanDoi(attributes.href);
    if (doi !== "") return doi;
  }
  return "";
}

/**
 * The PDF URL of one arXiv entry.
 *
 * Atom guarantees nothing about attribute order, and the live feed sends
 * `<link href="..." rel="related" type="application/pdf" title="pdf"/>` — href first. A
 * pattern that requires `title="pdf"` to precede `href` never matched, so every candidate
 * from the one source that exists to hand out direct PDF links arrived with `pdfUrl: ""`.
 * Parse the attributes instead of their positions.
 */
function arxivPdfUrl(entry, absUrl) {
  for (const match of entry.matchAll(/<link\b[^>]*>/g)) {
    const attributes = tagAttributes(match[0]);
    if (attributes.title !== "pdf" && attributes.type !== "application/pdf") continue;
    const href = String(attributes.href ?? "").trim();
    if (href !== "") return href;
  }
  // Every entry carries an abs URL, and arXiv serves the PDF at the same path under /pdf/.
  const abs = String(absUrl ?? "").trim();
  return /\/abs\//.test(abs) ? abs.replace("/abs/", "/pdf/") : "";
}

/**
 * arXiv returns Atom XML; parse the handful of fields we need without a dep.
 *
 * Exported for the gate: the two defects this function has shipped with (DOI and PDF URL,
 * see `arxivDoi`/`arxivPdfUrl`) both parsed to an empty string, which no assertion about
 * "the entry was parsed" could have seen. The gate feeds it real feed text instead.
 */
export function parseArxivXml(xml, limit) {
  const entries = xml.split(/<entry>/).slice(1);
  const candidates = [];
  for (const entry of entries.slice(0, limit)) {
    const pick = (tag) => {
      const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
      return match === null ? "" : match[1].trim();
    };
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((match) => match[1].trim()).join("; ");
    const absUrl = pick("id");
    const published = pick("published");
    candidates.push({
      title: pick("title").replace(/\s+/g, " "),
      authors,
      year: published.slice(0, 4),
      venue: "arXiv",
      doi: arxivDoi(entry),
      abstract: pick("summary").replace(/\s+/g, " ").slice(0, 2000),
      url: absUrl,
      citations: 0,
      // arXiv publishes no citation counts. Marked explicitly so a citation sort does not
      // read "0 citations" as "cited by nobody" and bury preprints — which are exactly the
      // source of the newest work.
      citationsKnown: false,
      openAccess: true,
      pdfUrl: arxivPdfUrl(entry, absUrl),
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
    // Same distinction as fetchJson: a user cancellation must not be reported as a
    // source timeout, or the UI shows "arxiv: timed out" for a search the user stopped.
    if (signal?.aborted === true) throw error;
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
 * Semantic Scholar.
 *
 * Worth having before PubMed for this library: it reports `citationCount` *and*
 * `influentialCitationCount`, and its coverage of management/social-science venues is far
 * better than PubMed's biomedical one. No API key is required for the public endpoint; it
 * is rate-limited, which is why sources are queried sequentially rather than in parallel.
 */
async function searchSemanticScholar(query, limit, signal) {
  const fields = "title,authors,year,venue,externalIds,abstract,citationCount,influentialCitationCount,openAccessPdf,url";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`;
  const response = await fetchJson(url, signal);
  if (!response.ok) {
    return { source: "semanticscholar", ok: false, reason: response.reason, candidates: [] };
  }
  const rows = Array.isArray(response.value?.data) ? response.value.data : [];
  const candidates = rows.map((paper) => ({
    title: String(paper.title ?? "").trim(),
    authors: Array.isArray(paper.authors)
      ? paper.authors.map((entry) => entry?.name).filter((name) => typeof name === "string").join("; ")
      : "",
    year: paper.year === undefined || paper.year === null ? "" : String(paper.year),
    venue: String(paper.venue ?? "").trim(),
    // externalIds.DOI is bare, unlike OpenAlex which returns a URL.
    doi: cleanDoi(paper.externalIds?.DOI),
    abstract: String(paper.abstract ?? "").trim(),
    url: String(paper.url ?? ""),
    citations: typeof paper.citationCount === "number" ? paper.citationCount : 0,
    // Kept separate from `citations`: a paper cited 300 times but influencing few is a
    // different signal from one cited 300 times that anchors a field. Not surfaced in the
    // UI yet, but discarded at fetch time it would have to be fetched again.
    influentialCitations: typeof paper.influentialCitationCount === "number" ? paper.influentialCitationCount : 0,
    openAccess: paper.openAccessPdf !== null && paper.openAccessPdf !== undefined,
    pdfUrl: String(paper.openAccessPdf?.url ?? ""),
    source: "semanticscholar",
  }));
  return { source: "semanticscholar", ok: true, candidates: candidates.filter((item) => item.title !== "") };
}

/**
 * PubMed (NCBI E-utilities).
 *
 * Two requests: esearch returns IDs, esummary returns records. PubMed has no citation
 * counts at all, so `citations` is honestly 0 rather than absent — the sort code treats a
 * missing count differently from a known zero (see `mergeCandidates`).
 *
 * Expected to return nothing for most queries in this library. It is here because the
 * planning document names it, and a source that honestly returns zero results is better
 * than pretending the capability does not exist.
 */
async function searchPubMed(query, limit, signal) {
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const searchUrl = `${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&term=${encodeURIComponent(query)}`;
  const searchResponse = await fetchJson(searchUrl, signal);
  if (!searchResponse.ok) {
    return { source: "pubmed", ok: false, reason: searchResponse.reason, candidates: [] };
  }
  const ids = Array.isArray(searchResponse.value?.esearchresult?.idlist)
    ? searchResponse.value.esearchresult.idlist
    : [];
  if (ids.length === 0) return { source: "pubmed", ok: true, candidates: [] };

  const summaryUrl = `${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`;
  const summaryResponse = await fetchJson(summaryUrl, signal);
  if (!summaryResponse.ok) {
    // The search worked but the second call failed. Report the source as failed rather
    // than returning an empty success: "no results" and "lookup broke" are different
    // facts, and only one of them should make the user retry.
    return { source: "pubmed", ok: false, reason: summaryResponse.reason, candidates: [] };
  }
  const result = summaryResponse.value?.result ?? {};
  // Keep the id alongside its record: esummary returns an object keyed by id, so the
  // canonical PubMed URL can only be built from the key, not from the record body.
  const candidates = ids
    .map((id) => ({ id, entry: result[id] }))
    .filter((pair) => pair.entry !== undefined && pair.entry !== null)
    .map(({ id, entry }) => ({
      title: String(entry.title ?? "").replace(/\.$/, "").trim(),
      authors: Array.isArray(entry.authors)
        ? entry.authors.map((author) => author?.name).filter((name) => typeof name === "string").join("; ")
        : "",
      // pubdate is a string like "2021 Mar" or "2021"; keep the year only.
      year: String(entry.pubdate ?? "").slice(0, 4),
      venue: String(entry.fulljournalname ?? entry.source ?? "").trim(),
      doi: cleanDoi((entry.articleids ?? []).find((item) => item?.idtype === "doi")?.value),
      abstract: "",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      // PubMed does not publish citation counts. Zero is the honest value, and the merge
      // step knows that a known zero ranks below a known count but does not delete it.
      citations: 0,
      citationsKnown: false,
      openAccess: false,
      pdfUrl: "",
      source: "pubmed",
    }))
    .filter((item) => item.title !== "");
  return { source: "pubmed", ok: true, candidates };
}

/**
 * Query one or more sources and merge the candidates.
 *
 * Duplicates are collapsed by DOI and then by normalised title, because the same paper is
 * routinely returned by two sources with different rankings.
 *
 * @param {string} query
 * @param {{limit?: number, sources?: string[], sort?: "relevance"|"citations"|"year", signal?: AbortSignal}} options
 */
export async function searchExternal(query, options = {}) {
  const text = String(query ?? "").trim();
  if (text === "") return { query: "", candidates: [], sources: [], failures: [] };
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  const wanted = Array.isArray(options.sources) && options.sources.length > 0
    ? options.sources.filter((source) => SOURCES.includes(source))
    : SOURCES;
  const runners = {
    openalex: searchOpenAlex,
    crossref: searchCrossref,
    arxiv: searchArxiv,
    semanticscholar: searchSemanticScholar,
    pubmed: searchPubMed,
  };

  // Sequential with a per-source budget: five parallel requests from one
  // plugin is a good way to get rate-limited by all five.
  const results = [];
  const failures = [];
  for (const source of wanted) {
    const result = await runners[source](text, limit, options.signal);
    results.push(result);
    if (!result.ok) failures.push({ source, reason: result.reason });
  }

  const merged = mergeCandidates(results, { limit, sources: wanted, sort: options.sort });
  return { query: text, candidates: merged, sources: wanted, failures };
}

/**
 * Order one source's own results.
 *
 * Each source is ranked internally first, because citation counts are not comparable
 * across sources: OpenAlex and Crossref report real counts, arXiv has none, and PubMed
 * publishes none. Comparing them in one global sort would rank a preprint with 0 next to a
 * 4000-citation article as if the numbers meant the same thing.
 */
function orderWithinSource(candidates, sort) {
  const rows = candidates.slice();
  if (sort === "year") {
    rows.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
  } else if (sort === "citations") {
    // `citationsKnown === false` means the source does not publish counts, not that the
    // paper has none. Ranking those as zero would pit "unknown" against "known zero" and
    // lose — so unknown-count papers keep their original (relevance) order and are not
    // demoted by the sort at all. They stay interleaved by source quota instead.
    const known = rows.filter((item) => item.citationsKnown !== false);
    const unknown = rows.filter((item) => item.citationsKnown === false);
    known.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0));
    return [...known, ...unknown];
  }
  return rows;
}

/**
 * Merge candidates across sources without letting source order decide the result.
 *
 * The previous implementation concatenated per-source results and truncated, so whichever
 * source was asked first always filled the visible list — arXiv preprints could never
 * appear above an OpenAlex result, while the UI presented the list as relevance-ranked.
 * That is a structural bias, not a missing feature.
 *
 * The fix is a per-source quota: round-robin across sources, so every source that returned
 * something gets representation before any source gets a second slot. A source that
 * contributes nothing (PubMed on a management query) simply yields no slots — it does not
 * reserve them.
 */
export function mergeCandidates(results, options = {}) {
  const limit = Math.max(1, options.limit ?? 10);
  const sort = options.sort ?? "relevance";
  const quota = Math.max(2, Math.ceil(limit / Math.max(1, results.length)) * 2);

  const prepared = results
    .filter((result) => result.ok)
    .map((result) => ({
      source: result.source,
      rows: orderWithinSource(result.candidates, sort).slice(0, quota),
    }))
    // Sort the queues by source name before interleaving. Without this the round-robin
    // order is the input order, so swapping the order sources were queried in changes the
    // result — which is the exact bias this function exists to remove, just moved one
    // level down. Sorting here makes the output a function of the *content* alone.
    .sort((a, b) => a.source.localeCompare(b.source));

  // Under a citation sort, a source that publishes no counts must not outrank sources that
  // do: otherwise "unknown" silently wins over "300 citations", which is a worse lie than
  // burying it. Such sources are interleaved after the counted ones — present, ordered, and
  // clearly not ranked against numbers they never reported.
  const counts = (queue) => queue.rows.some((row) => row.citationsKnown !== false);
  const primary = sort === "citations" ? prepared.filter(counts) : prepared;
  const secondary = sort === "citations" ? prepared.filter((queue) => !counts(queue)) : [];
  const queues = [...primary, ...secondary];

  const seenDoi = new Set();
  const seenTitle = new Set();
  const merged = [];
  // Round-robin, not source-by-source. `depth` walks each queue in lockstep so the first
  // result of every source lands before the second result of any source.
  for (let depth = 0; merged.length < limit * Math.max(1, queues.length); depth += 1) {
    let addedThisRound = false;
    for (const queue of queues) {
      const candidate = queue.rows[depth];
      if (candidate === undefined) continue;
      addedThisRound = true;
      const doiKey = String(candidate.doi ?? "").toLowerCase();
      const titleKey = String(candidate.title ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "").slice(0, 80);
      if (doiKey !== "" && seenDoi.has(doiKey)) continue;
      if (titleKey !== "" && seenTitle.has(titleKey)) continue;
      if (doiKey !== "") seenDoi.add(doiKey);
      if (titleKey !== "") seenTitle.add(titleKey);
      merged.push(candidate);
    }
    if (!addedThisRound) break;
  }
  return merged;
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

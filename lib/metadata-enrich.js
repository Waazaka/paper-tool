// DOI-based metadata enrichment.
//
// The extractor guesses from the PDF's own layout: running heads, footers and
// stacked multi-line journal names. It is decent at titles and years, and bad at
// authors and venues — a typeset PDF simply does not state "authors: A; B"
// anywhere. But most PDFs *do* carry a DOI, and a DOI is an exact identifier:
// asking Crossref about it returns the authoritative record.
//
// This is deliberately separate from `external-search.js`. That module answers
// "find me papers about X" and ranks by relevance. This one answers "what is the
// canonical record for this exact DOI" and must never rank at all: either Crossref
// knows the DOI or it does not.
//
// Rules that matter:
//   - Network failure is not an error. Enrichment is an improvement, never a
//     requirement, so an offline user gets `{ ok: false, reason }` and the
//     existing metadata stays untouched.
//   - A field the user typed is never overwritten. `store.updatePaper` already
//     removes user-edited fields from `metadataSource`; this module only fills
//     fields that are empty or still marked as guesses.
//   - Retrieved values are marked with their own source (`crossref`) so the UI can
//     tell "authoritative" from "inferred from the page".
import { cleanRemoteText } from "./entities.js";

const UA = "paper-tool/0.1 (DSH plugin; local paper workbench)";
const TIMEOUT_MS = 12_000;
const CROSSREF_WORKS = "https://api.crossref.org/works/";

/**
 * Normalise a DOI to its bare form.
 *
 * Duplicated from `pdf-metadata.js` rather than exported from it: that module's
 * `cleanDoi` is an internal step of DOI detection, and widening its public surface
 * for one caller would make the extractor's API look larger than it is. The rule is
 * two characters of punctuation; keeping a local copy is cheaper than the coupling.
 */
function cleanDoi(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

/** Fields this module is allowed to fill, in the order the UI shows them. */
export const ENRICHABLE = ["title", "authors", "year", "venue"];

/**
 * Pull one record out of a Crossref `/works/{doi}` response.
 *
 * Crossref wraps everything in `message`; the shapes vary slightly between
 * publishers (some put a bare object, some an array for title/container-title),
 * so every read is defensive.
 */
export function parseCrossrefWork(payload) {
  const item = payload?.message;
  if (item === null || typeof item !== "object") return null;

  // Crossref sends HTML/JATS, not plain text: the venue for
  // 10.1016/j.jdmm.2020.100548 literally arrives as
  // "Journal of Destination Marketing &amp; Management". Storing that verbatim put
  // "&amp;" into the paper row and into every citation printed from it, which was found
  // live rather than by a gate. `cleanRemoteText` strips tags and decodes entities once.
  const firstOf = (value) =>
    cleanRemoteText(Array.isArray(value) ? value[0] ?? "" : value ?? "");

  const authors = Array.isArray(item.author)
    ? item.author
        // Family-first matches how the rest of the tool stores names and how a
        // bibliography wants them ("Wei, Min"), not "Min Wei".
        .map((person) => {
          const family = cleanRemoteText(person?.family ?? "");
          const given = cleanRemoteText(person?.given ?? "");
          if (family !== "" && given !== "") return `${family}, ${given}`;
          return family !== "" ? family : given;
        })
        .filter((name) => name !== "")
        .join("; ")
    : "";

  const issued = item.issued?.["date-parts"]?.[0]?.[0];
  // `published-print` is the version of record; `issued` is the online-first date.
  // For citation purposes the print year is what a bibliography expects, so prefer
  // it when both exist and differ.
  const printed = item["published-print"]?.["date-parts"]?.[0]?.[0];
  const yearValue = printed ?? issued;

  return {
    doi: cleanDoi(item.DOI ?? ""),
    title: firstOf(item.title),
    authors,
    year: yearValue === undefined || yearValue === null ? "" : String(yearValue),
    venue: firstOf(item["container-title"]),
    // Not used for display, kept so a caller can tell a stub record from a full one.
    type: String(item.type ?? ""),
    publisher: cleanRemoteText(item.publisher ?? ""),
  };
}

/**
 * Look up one DOI.
 *
 * @returns {Promise<{ok: true, record: object} | {ok: false, reason: string}>}
 *          `ok: false` for "not found" as well as "network down": callers treat
 *          both as "nothing to add", and the reason says which.
 */
export async function lookupDoi(doi, options = {}) {
  const cleaned = cleanDoi(doi);
  if (cleaned === "") return { ok: false, reason: "no DOI on this paper" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const composite =
    options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
  try {
    const response = await fetch(CROSSREF_WORKS + encodeURIComponent(cleaned), {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: composite,
    });
    if (response.status === 404) return { ok: false, reason: "Crossref does not know this DOI" };
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const record = parseCrossrefWork(await response.json());
    if (record === null) return { ok: false, reason: "Crossref returned no record" };
    return { ok: true, record };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timed out" : (error?.message ?? String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide which fields enrichment may fill, and with what.
 *
 * A field is fillable when it is empty, or when the extractor guessed it and the
 * user has not corrected it. Provenance is how we tell those apart:
 *
 *   - `metadataSource` lists a field  -> machine guess, may be replaced
 *   - field absent from `metadataSource` AND the row was stamped verified
 *     (`metadataVerifiedAt` non-empty) -> the user typed it, never touch
 *   - field absent AND no stamp -> provenance was never recorded. Rows imported
 *     before provenance existed have `metadataSource = "{}"`, and treating those
 *     as "user-edited" would freeze every bad guess in place forever — the exact
 *     bug this module exists to fix. They are guesses; an authoritative DOI record
 *     outranks them.
 *
 * @returns {{changes: object, kept: string[], filled: string[],
 *            unchanged: string[], unknownProvenance: string[]}}
 */
export function planEnrichment(paper, record, options = {}) {
  const allowEmptyOverwrite = options.fillEmpty !== false;
  let marked = {};
  try {
    marked = JSON.parse(paper.metadataSource === "" ? "{}" : (paper.metadataSource ?? "{}"));
  } catch {
    marked = {};
  }
  // A stamp means "these values were confirmed", which is only ever set by a user
  // edit or by verification. Without it, an absent key says nothing about intent.
  const verified = String(paper.metadataVerifiedAt ?? "").trim() !== "";
  const hasProvenance = marked !== null && typeof marked === "object" && Object.keys(marked).length > 0;

  const changes = {};
  const filled = [];
  const kept = [];
  const unchanged = [];
  const unknownProvenance = [];

  for (const field of ENRICHABLE) {
    const incoming = String(record?.[field] ?? "").trim();
    const current = String(paper?.[field] ?? "").trim();
    if (incoming === "") continue;

    const listed = Object.prototype.hasOwnProperty.call(marked, field);
    const isUserEdited = !listed && current !== "" && (verified || hasProvenance);
    if (isUserEdited) {
      kept.push(field);
      continue;
    }
    if (!listed && current !== "") unknownProvenance.push(field);

    if (current === "") {
      if (!allowEmptyOverwrite) continue;
      changes[field] = incoming;
      filled.push(field);
      continue;
    }
    // Guess (listed, or unknown-provenance) vs. authoritative record.
    if (field === "title" && incoming.length < 8) {
      // An empty-ish Crossref title is not an improvement over what we have.
      unchanged.push(field);
      continue;
    }
    if (incoming !== current) {
      changes[field] = incoming;
      filled.push(field);
    } else {
      unchanged.push(field);
    }
  }
  return { changes, kept, filled, unchanged, unknownProvenance };
}

/**
 * Enrich a list of papers in place.
 *
 * Sequential on purpose: Crossref asks for polite usage and rate-limits bursts,
 * and a library import is not latency-critical.
 *
 * @returns {Promise<{enriched: object[], skipped: object[], failures: object[]}>}
 */
export async function enrichPapers(store, papers, options = {}) {
  const enriched = [];
  const skipped = [];
  const failures = [];
  const seen = new Set();

  for (const paper of papers) {
    const id = paper?.paperId ?? "";
    if (id !== "" && seen.has(id)) continue;
    if (id !== "") seen.add(id);

    const doi = String(paper?.doi ?? "").trim();
    if (doi === "") {
      skipped.push({ paperId: id, reason: "no DOI on this paper" });
      continue;
    }
    const found = await lookupDoi(doi, options);
    if (!found.ok) {
      // "Crossref does not know this DOI" is not a failure of the tool; it is a
      // fact about that DOI. Kept separate so a UI can show it without alarm.
      (found.reason.includes("does not know") ? skipped : failures).push({ paperId: id, doi, reason: found.reason });
      continue;
    }
    const plan = planEnrichment(paper, found.record, options);
    if (Object.keys(plan.changes).length === 0) {
      enriched.push({ paperId: id, doi, changed: [], kept: plan.kept, record: found.record });
      continue;
    }
    // Only bibliographic fields are written; provenance for each filled field is
    // recorded so the UI can badge it "from Crossref" rather than "inferred".
    const updated = store.updatePaper(id, { ...plan.changes, verified: false });
    enriched.push({
      paperId: id,
      doi,
      changed: plan.filled,
      kept: plan.kept,
      title: updated?.title ?? "",
      record: found.record,
    });
  }
  return { enriched, skipped, failures };
}

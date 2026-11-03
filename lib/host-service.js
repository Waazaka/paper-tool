// Host service for the paper tool.
//
// One operation, two callers: every capability below is a plain service method.
// The sidebar calls it through the authenticated RPC channel and the agent
// calls it through a tool; neither path keeps its own logic.
//
// Session isolation follows the verified shape in @local/dsh-zotero-workbench:
// the first Remote parameter is a Host-resolved scope, so the browser only ever
// sends a session id.
import { RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { basename, join } from "node:path";
import { openStore, defaultDbPath, sharedDbPath, adoptLegacyLibrary } from "./store.js";
import { extractPdfPages, guessMetadata } from "./pdf-extract.js";
import { rasterizePdfPages } from "./pdf-raster.js";
import { ocrAvailable, ocrPages } from "./ocr.js";
import { readPdfjsRuntime, readPdfjsAsset } from "./gui-assets.js";
import { availableStyles, renderBibliography, normalizeLocale } from "./citeproc.js";
import { renderBibtex } from "./bibtex.js";
import { searchExternal as searchExternalQuery, importCandidates } from "./external-search.js";
import { enrichPapers, planEnrichment, lookupDoi } from "./metadata-enrich.js";
import { judgeStance, STANCE_STRENGTHS } from "./stance.js";
import {
  connect as cnkiConnect,
  disconnect as cnkiDisconnect,
  status as cnkiStatus,
  search as cnkiSearch,
  downloadPdf as cnkiDownloadPdf,
} from "./cnki.js";
import { markRemote } from "./remote-mark.js";
import { isPdfName, SettleTracker } from "./watch.js";
import { alignSegments, splitPageSegments } from "./translate.js";

const SERVICE_KEY = "paperTool";
const LOOKUP = "paperToolScope";
// Bounds the browser's JSON-encoded upload; the client enforces the same cap
// before reading the file so a huge PDF fails with a readable message instead
// of freezing the tab while it re-encodes bytes as a number array.
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_FILES = 32;
// Recognition costs ~1s/page and runs inside an import the user waits on, so a
// long scan is refused up front rather than left to time out halfway.
const MAX_OCR_PAGES = 40;

/** Fields the sidebar list actually renders. */
const LIST_FIELDS = [
  "paperId", "title", "authors", "year", "venue", "doi", "source",
  "pdfPath", "numPages", "indexedAt", "material",
];

/**
 * Shrink a stored paper row to what the sidebar list can display.
 *
 * Why: the list used to ship `SELECT *` over the wire — every row carried
 * `fingerprint` (a SHA-256 hex string, pure waste: the client has never read it)
 * and `metadataSource` (a JSON provenance map, sometimes a few hundred bytes).
 * Multiplied by a page of papers it was the bulk of the payload, and it is
 * re-sent on every refresh.
 *
 * `metadataSource` cannot simply be dropped: two card badges are derived from it
 * — "these fields are still guesses" and "these came from Crossref". Deriving
 * those here and sending two short arrays keeps the badges correct while moving
 * the parse off the main thread and off the wire. The full row is still
 * retrievable through `readPaper` for the metadata editor, which does need
 * `abstract`.
 *
 * The parse is duplicated from the client's `guessedFields`/`crossrefFields` on
 * purpose rather than shared: those live in a bundle with no module exports, and
 * a gate asserts both sides agree field by field.
 */
export function projectPaperForList(row) {
  if (row === null || typeof row !== "object") return row;
  const out = {};
  for (const field of LIST_FIELDS) out[field] = row[field];

  // Same five editable fields the badges cover, in the same order.
  const known = ["title", "authors", "year", "venue", "doi"];
  const unverified = [];
  const fromCrossref = [];
  let parsed = null;
  const raw = row.metadataSource;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt provenance must not be read as "everything verified". The
      // client's rule is to claim nothing in that case, so emit no badges.
      parsed = null;
    }
  }
  if (parsed !== null && typeof parsed === "object") {
    for (const field of known) {
      const source = parsed[field];
      if (typeof source !== "string" || source === "") continue;
      const value = typeof row[field] === "string" ? row[field].trim() : "";
      // Only a value that exists can be doubted or credited.
      if (value === "") continue;
      // xmp/info/subject come from the file or publisher and are not guesses.
      if (source === "layout" || source === "filename" || source === "page-text") unverified.push(field);
      else if (source === "crossref") fromCrossref.push(field);
    }
  }
  out.unverifiedFields = unverified;
  out.fromCrossrefFields = fromCrossref;
  return out;
}

export class PaperToolService extends TypertRemoteService {
  static inject = ["sessions", "typert"];

  constructor(ctx, config = {}) {
    super(ctx, SERVICE_KEY);
    this.config = config;
    /** @type {Map<string, import("node:sqlite").DatabaseSync>} */
    this.stores = new Map();
    this.ctx = ctx;
    /**
     * The active watch folder, or null.
     *
     * @type {{ dir: string, sessionId: string, watcher: import("node:fs").FSWatcher,
     *          settle: SettleTracker, seen: Set<string>, timer: any,
     *          imported: number, failed: number, duplicates: number } | null}
     */
    this.watchState = null;

    ctx.inject(["sessions", "typert"], (scope) => {
      scope.typert.lookups.register(LOOKUP, {
        parameter: LOOKUP,
        wire: "paperSessionId",
        hostTypeSymbol: "@local/paper-tool#PaperScope",
        wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
        resolve: async (sessionId) => {
          if (typeof sessionId !== "string" || sessionId === "") return undefined;
          const live = scope.sessions.get(sessionId)?.header;
          const stored =
            live === undefined ? await scope.get("sessionPersistence")?.stat(sessionId) : undefined;
          const header = live ?? stored?.header;
          if (header === undefined) return undefined;
          return { sessionId, workspaceRoot: header.cwd ?? null };
        },
      });
    });
  }

  /**
   * The library for a scope.
   *
   * A `config.dbPath` wins outright, and a `config.shared` of `false` restores
   * the old one-library-per-workspace behaviour. Otherwise the library is shared
   * across workspaces, because a personal research library is not a property of
   * the folder you happen to have open — opening the workbench from another
   * workspace used to show an empty shelf and look like the papers were gone.
   */
  storeFor(scope) {
    const root = scope.workspaceRoot;
    if (typeof root !== "string" || root === "") {
      throw new RemoteError("paper-tool/no-workspace", "this session has no workspace directory");
    }
    const shared = this.config.shared !== false ? sharedDbPath(this.config.homeDir) : null;
    const dbPath = this.config.dbPath ?? shared ?? defaultDbPath(root);
    let store = this.stores.get(dbPath);
    if (store === undefined) {
      // Moving the library from the workspace to the profile would otherwise
      // present an empty shelf to every existing user — their papers would look
      // deleted. Fold the old file in once, before opening, so the very first
      // session after the upgrade sees the papers it already had.
      if (shared !== null && this.config.dbPath === undefined) {
        adoptLegacyLibrary(defaultDbPath(root), dbPath);
      }
      store = openStore(dbPath);
      this.stores.set(dbPath, store);
    }
    return store;
  }

  /**
   * Release every open database handle.
   *
   * The service is constructed once per plugin load and the profile reloads
   * plugins on change, so without this each reload leaks a `DatabaseSync` plus
   * its WAL and SHM files, and the user cannot move or delete the workspace
   * directory afterwards.
   */
  dispose() {
    // A leaked watcher keeps the process alive and can write into the library
    // after the service that owns the store is gone.
    if (this.watchState !== null) {
      try { this.watchState.watcher.close(); } catch { /* already closed */ }
      if (this.watchState.timer !== null) clearInterval(this.watchState.timer);
      this.watchState = null;
    }
    for (const store of this.stores.values()) {
      try {
        store.close();
      } catch {
        /* an already-closed handle is not an error worth surfacing */
      }
    }
    this.stores.clear();
  }

  /**
   * Where imported PDF bytes live.
   *
   * Follows the same choice as `storeFor`: with a shared library the bytes must
   * live beside it, or a paper imported in one workspace would have a `pdfPath`
   * pointing at a directory the other workspace cannot reason about. Keeping the
   * bytes next to their database means the read/OCR path never has to ask which
   * workspace a row came from.
   */
  filesDir(scope) {
    const root = scope.workspaceRoot;
    if (typeof root !== "string" || root === "") {
      throw new RemoteError("paper-tool/no-workspace", "this session has no workspace directory");
    }
    const shared = this.config.shared !== false ? sharedDbPath(this.config.homeDir) : null;
    if (this.config.dbPath !== undefined || shared !== null) {
      const owner = this.config.dbPath !== undefined
        ? this.config.dbPath.replace(/[\\/][^\\/]*$/, "")
        : shared.replace(/[\\/][^\\/]*$/, "");
      return join(owner, "files");
    }
    return join(root, ".dsh", "paper-tool", "files");
  }

  /**
   * OCR a scanned PDF so its pages become searchable.
   *
   * Returns null when OCR cannot run, and the caller then stores the paper as
   * metadata-only — the same state it would have had before this existed. That
   * is deliberate: a missing OCR engine must degrade to "no text", never to
   * "import failed", and never to "text that is silently wrong".
   *
   * Page count is capped because recognition costs roughly a second per page
   * and this runs inside an import the user is waiting on.
   */
  /**
   * `pageCap` overrides the configured cap for one run.
   *
   * The import path and the manual re-run want different limits. Import runs while the
   * user is waiting, so the default cap (40) protects them from what looks like a hang.
   * A manual re-run is an explicit request for one specific paper, so it passes a larger
   * cap — otherwise the feature exists precisely for the papers it still refuses.
   */
  async #runOcr(bytes, extracted, signal, pageCap) {
    this.ocrSkipReason = "";
    // The cap is a default, not a law. It exists because OCR runs synchronously inside
    // the import the user is waiting on (~1s/page), so a 200-page scan would look like a
    // hang. That reasoning is about the *default*, not about the maximum: a 90-page
    // dissertation is exactly this tool's audience, and refusing it forever because the
    // import would be slow is the wrong trade. `config.maxOcrPages` lets the user raise it.
    const maxOcrPages = resolveOcrPageCap(this.config, pageCap);
    if (extracted.numPages > maxOcrPages) {
      this.ocrSkipReason = `the PDF has ${extracted.numPages} pages, more than the ${maxOcrPages}-page OCR cap`;
      return null;
    }
    // Checkpoint before each expensive phase rather than only at the start: OCR is
    // roughly a second per page, so a cancellation that only lands after recognition
    // finishes is indistinguishable from no cancellation at all.
    signal?.throwIfAborted();
    const status = await ocrAvailable();
    if (!status.available) {
      this.ocrSkipReason = status.reason;
      return null;
    }
    let raster;
    try {
      signal?.throwIfAborted();
      raster = await rasterizePdfPages(bytes);
    } catch (error) {
      // A cancellation must not be reported as "page rendering failed": that would
      // tell the user their PDF is broken when they were the one who stopped it.
      if (isAbortError(error)) throw error;
      this.ocrSkipReason = `page rendering failed: ${describeUnknown(error)}`;
      return null;
    }
    if (raster.pages.length === 0) {
      this.ocrSkipReason = "no page could be rendered";
      return null;
    }
    let texts;
    try {
      signal?.throwIfAborted();
      texts = await ocrPages(
        raster.pages.map((page) => page.png),
        { language: status.language, signal },
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.ocrSkipReason = `recognition failed: ${describeUnknown(error)}`;
      return null;
    }
    // Map recognised text back onto absolute page indexes. A page that failed
    // recognition stays "" — it is not filled with a neighbour's text.
    const pages = new Array(extracted.numPages).fill("");
    const pageSources = new Array(extracted.numPages).fill("text-layer");
    let pagesRecognised = 0;
    let pagesFailed = 0;
    for (let index = 0; index < raster.pages.length; index += 1) {
      const pageIndex = raster.pages[index].pageIndex;
      const text = texts[index];
      if (typeof text === "string" && text !== "") {
        pages[pageIndex] = text;
        pageSources[pageIndex] = "ocr";
        pagesRecognised += 1;
      } else {
        pagesFailed += 1;
      }
    }
    if (pagesRecognised === 0) {
      this.ocrSkipReason = "no page produced readable text";
      return null;
    }
    return { pages, pageSources, pagesRecognised, pagesFailed, language: status.language };
  }

  /**
   * Best-effort Crossref enrichment for one paper.
   *
   * Never throws: it runs inside an import the user is waiting on, and a Crossref
   * outage must not turn a successful import into a failure. Returns the outcome so
   * a caller that cares (the import summary) can report what happened.
   *
   * @param {object} store
   * @param {string} paperId
   * @returns {Promise<{changed: string[], reason?: string}>}
   */
  async #enrichOne(store, paperId) {
    try {
      const paper = store.getPaper(paperId);
      if (paper === null) return { changed: [], reason: "paper vanished" };
      const doi = String(paper.doi ?? "").trim();
      if (doi === "") return { changed: [], reason: "no DOI" };
      const found = await lookupDoi(doi);
      if (!found.ok) return { changed: [], reason: found.reason };
      const plan = planEnrichment(paper, found.record);
      const fields = Object.keys(plan.changes);
      if (fields.length === 0) return { changed: [] };
      store.updatePaper(paperId, { ...plan.changes, verified: false });
      // Record that these values came from an authority, not from the page.
      let marked = {};
      try {
        const row = store.getPaper(paperId);
        marked = JSON.parse(row?.metadataSource === "" ? "{}" : (row?.metadataSource ?? "{}"));
      } catch {
        marked = {};
      }
      for (const field of fields) marked[field] = "crossref";
      store.setMetadataSource(paperId, JSON.stringify(marked));
      store.clearMetadataVerifiedAt(paperId);
      return { changed: fields };
    } catch (error) {
      return { changed: [], reason: String(error?.message ?? error) };
    }
  }

  /**
   * OCR a paper that was imported before OCR existed, or whose earlier
   * recognition failed. Idempotent: it replaces page text rather than appending.
   */
  async ocrPaper(paperToolScope, input, signal) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    const paper = store.getPaper(paperId);
    if (paper === null) throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    if (typeof paper.pdfPath !== "string" || paper.pdfPath === "") {
      throw new RemoteError("paper-tool/no-pdf", "this paper has no stored PDF to OCR");
    }
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await readFile(paper.pdfPath));
    signal?.throwIfAborted();
    const extracted = await extractPdfPages(bytes);
    const existingText = extracted.pages.filter((page) => page.trim() !== "").length;
    if (existingText > 0) {
      return {
        paperId,
        skipped: true,
        reason: "this PDF already has a text layer; OCR would replace correct text with guesses",
      };
    }
    // Cancellation rolls the paper back to the state it had before this call. The
    // write below only happens after OCR fully succeeds, and #runOcr rethrows an
    // AbortError instead of returning a partial result — so a cancelled run leaves
    // `material`, `pages` and `pageSources` exactly as they were. Do not change this
    // into "keep the pages recognised so far": that would create a paper whose
    // material says `ocr` while only some pages carry text, and the three-state
    // metadata/ocr/fulltext model has no fourth state for that.
    // A manual re-run passes a much larger cap than an import does. The user asked for
    // this specific paper, so the "you'd be waiting a while" objection that justifies the
    // 40-page import cap does not apply — but an unbounded cap would, so it stays finite
    // and the caller sees the page count before committing (see the client's confirm).
    const MANUAL_OCR_CAP = 400;
    const ocr = await this.#runOcr(bytes, extracted, signal, MANUAL_OCR_CAP);
    if (ocr === null) {
      return { paperId, skipped: true, reason: this.ocrSkipReason };
    }
    const updated = store.upsertPaper({
      ...paper,
      material: "ocr",
      textSource: "ocr",
      pages: ocr.pages,
      pageSources: ocr.pageSources,
    });
    // Replacing the page text invalidates every character offset anchored into the old
    // text. Evidence and annotations keep their quote — that is the user's record — but
    // the offsets are recomputed against the new text. Quotes that no longer appear are
    // marked -1 (not found) instead of being dropped or guessed: the evidence is still
    // real, we just lost track of where it sits.
    const locate = (quote) => {
      for (let index = 0; index < ocr.pages.length; index += 1) {
        const anchor = locateQuote(ocr.pages[index] ?? "", quote);
        if (anchor !== null) return { pageIndex: index, charStart: anchor.start, charEnd: anchor.end };
      }
      return null;
    };
    const evidenceReanchor = store.reanchorEvidence(paperId, locate);
    const annotationReanchor = store.reanchorAnnotations(paperId, locate);
    return {
      paperId,
      material: updated.material,
      textSource: updated.textSource,
      pagesRecognised: ocr.pagesRecognised,
      pagesFailed: ocr.pagesFailed,
      language: ocr.language,
      // Reported to the caller so the UI can say what happened to existing anchors
      // instead of leaving the user to discover it later.
      reanchored: { evidence: evidenceReanchor, annotations: annotationReanchor },
    };
  }

  /**
   * Library status. Never throws for an empty library.
   * @param {PaperScope} paperToolScope
   */
  async status(paperToolScope) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    return {
      plugin: { name: "@local/paper-tool", service: SERVICE_KEY },
      session: { sessionId: paperToolScope.sessionId, workspaceRoot: paperToolScope.workspaceRoot },
      library: store.stats(),
      styles: await availableStyles(),
      pdfjs: { available: true },
      // The import limits are declared here, once. The client used to carry its
      // own copy of MAX_IMPORT_FILES, so changing one side produced "client lets
      // it through, Host rejects it" with no way to tell which number was real.
      limits: {
        maxImportFiles: MAX_IMPORT_FILES,
        maxPdfBytes: MAX_PDF_BYTES,
      },
      // Translation is an RPC path, not a tool (D-014), so this is where a caller
      // learns it exists. Reported as a count rather than a boolean: "0" and
      // "supported but unused" are different answers.
      translation: {
        supported: true,
        total: store.countTranslations(),
        // Said explicitly so nobody assumes the plugin can translate on its own.
        engine: "agent",
        indexed: false,
      },
    };
  }

  /**
   * Search pages and turn matched passages into stored evidence.
   *
   * This is the collection half of the evidence matrix: the agent asks for a
   * topic, and what comes back is anchored (paper + page + exact quote) so a
   * later sentence can point at it. Quotes are pulled from the stored page text
   * rather than the search snippet, because the snippet carries highlight
   * markers and elisions.
   *
   * @param {PaperScope} paperToolScope
   * @param {{query: string, paperId?: string, limit?: number}} input
   */
  async collectEvidence(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const query = requiredString(input?.query, "query").trim();
    if (query === "") throw new RemoteError("paper-tool/empty-query", "query is empty");
    const limit = clampInt(input?.limit, 10, 1, 100);
    const hits = store.search(query, { limit: limit * 4 });
    const evidenceRows = [];
    // Dedupe against what is already stored, not just within this call: asking
    // the same question twice must not grow the matrix with identical rows.
    const alreadyStored = new Set(
      store.listEvidence({ paperId: input?.paperId, limit: 5000 }).map(
        (row) => `${row.paperId}:${row.pageIndex}:${row.charStart}`,
      ),
    );

    for (const hit of hits) {
      if (evidenceRows.length >= limit) break;
      if (typeof input?.paperId === "string" && hit.paperId !== input.paperId) continue;
      const pageText = store.getPageText(hit.paperId, hit.pageIndex) ?? "";
      const span = pickQuote(pageText, query);
      if (span === null) continue;
      const dedupeKey = `${hit.paperId}:${hit.pageIndex}:${span.start}`;
      if (alreadyStored.has(dedupeKey)) continue;
      alreadyStored.add(dedupeKey);
      const evidenceId = randomUUID();
      const row = store.addEvidence({
        evidenceId,
        paperId: hit.paperId,
        pageIndex: hit.pageIndex,
        charStart: span.start,
        charEnd: span.end,
        quote: span.quote,
      });
      evidenceRows.push({ ...row, paperTitle: hit.title });
    }
    // Expose the same shape for both tool and UI.
    return { query, evidence: evidenceRows };
  }

  /**
   * List stored evidence, one page at a time.
   *
   * Was `{ limit: 2000 }` from the client on every refresh — a single store of
   * one evidence row re-serialised the whole library over the wire. The client
   * now asks for a page, plus the total so it can offer "load more" honestly.
   *
   * `anchor` is a filter, not an id list, and that distinction is the point: the
   * citation/export path must cover *all* citable evidence. When the client
   * passed the ids it had loaded, paging would have quietly shrunk the
   * bibliography to the first page of the list.
   */
  async listEvidence(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const limit = clampInt(input?.limit, 200, 1, 2000);
    const offset = clampInt(input?.offset, 0, 0, 1e6);
    const paperId = typeof input?.paperId === "string" && input.paperId !== "" ? input.paperId : undefined;
    const anchor = input?.anchor === "anchored" || input?.anchor === "unanchored" ? input.anchor : "all";
    const total = store.countEvidence({ paperId, anchor });
    return {
      evidence: store.listEvidence({ paperId, limit, offset, anchor }),
      paging: {
        offset,
        limit_returned: limit,
        total,
        hasMore: offset + limit < total,
        // Counts over the whole library, not over this page. The footer used to
        // derive them from `evidence.length`, which was the entire table; now that
        // the list is paged, deriving them client-side would report "the library
        // has 50 evidence rows" — and claim all 50 are anchored — on any larger
        // library. Both are also computed with the *unfiltered* paper scope so the
        // filter buttons can label themselves with real totals.
        anchoredTotal: store.countEvidence({ paperId, anchor: "anchored" }),
        allTotal: store.countEvidence({ paperId, anchor: "all" }),
      },
    };
  }

  /**
   * Build the skeleton of a review body: one slot per sentence, each slot
   * pre-bound to the evidence that may support it.
   *
   * Why a skeleton and not prose: this plugin has no model channel (no
   * `ctx.model`, no `generateText` anywhere in the host or client halves), and
   * adding one would make it a home-grown RAG endpoint — a different product from
   * "a paper tool that runs on DSH". The model does the writing, in chat, and this
   * method supplies the one thing a model cannot be trusted to produce: which
   * evidence each sentence is allowed to rest on.
   *
   * The design point that matters is that the *binding happens before the words
   * exist*. Handing a model a pile of quotes and asking it to cite them produces
   * plausible-looking sentences with anchors that do not actually support them, and
   * nothing catches it. Handing it slots that already carry their evidence means the
   * only degrees of freedom left are wording and order — the provenance is fixed
   * before the model touches it, and `renderBody` can then refuse anything whose
   * anchors do not resolve.
   *
   * @param {PaperScope} paperToolScope
   * @param {{section?: string, limit?: number, evidenceIds?: string[]}} input
   */
  async reviewBodyPlan(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const rows = Array.isArray(input?.evidenceIds) && input.evidenceIds.length > 0
      ? store.evidenceByIds(input.evidenceIds.filter((id) => typeof id === "string"), { limit: 500 })
      : store.listEvidence({ limit: clampInt(input?.limit, 200, 1, 500) });

    const wanted = typeof input?.section === "string" ? input.section.trim() : "";

    // Not enough material is a *reason*, not an empty document. Returning a shell
    // with a title and no slots would let the caller render an empty review and
    // believe it succeeded — the failure would surface as "the tool produced
    // nothing" instead of "there is no evidence yet".
    if (rows.length === 0) {
      const stats = store.stats();
      return {
        ok: false,
        slots: [],
        reason: stats.papers === 0
          ? "库是空的：先导入 PDF。"
          : `库里已有 ${stats.papers} 篇文献，但还没有证据条目，无法生成正文骨架。先用 paper_evidence（action=collect）收集证据。`,
        library: stats,
      };
    }

    const byPaper = new Map();
    for (const row of rows) {
      if (!byPaper.has(row.paperId)) byPaper.set(row.paperId, []);
      byPaper.get(row.paperId).push(row);
    }

    const slots = [];
    let index = 0;
    for (const [paperId, items] of byPaper) {
      const paper = store.getPaper(paperId);
      const title = paper?.title ?? items[0].paperTitle ?? paperId;
      const year = paper?.year ?? "";
      for (const item of items) {
        index += 1;
        slots.push({
          slotId: `s${index}`,
          // The slot states what this sentence is *about*, not what it must say.
          // Wording is the model's job; the direction of the claim (supports /
          // contradicts) comes from the paper, not from the sentence.
          topic: truncate(item.quote, 200),
          paperId,
          paperTitle: title,
          paperYear: year,
          pageIndex: item.pageIndex,
          // `charStart` is a real offset into the page text, so the eventual
          // citation can be re-checked against the source rather than trusted.
          charStart: item.charStart,
          charEnd: item.charEnd,
          evidence: [{ evidenceId: item.evidenceId, quote: item.quote }],
        });
      }
    }

    // Slots are grouped by paper so the model can write in a sensible order, but
    // the ids are global and stable across a call, which is what `renderBody` needs
    // to tell "you dropped a slot" from "you reordered them".
    return {
      ok: true,
      section: wanted === "" ? "综述正文" : wanted,
      slots,
      // The exact sentences the model is expected to fill, already carrying their
      // anchors. Printing this is what makes the contract legible in chat; the JSON
      // is what a programmatic caller feeds back to `renderBody`.
      text: [
        `正文骨架：${slots.length} 个句子槽位，覆盖 ${byPaper.size} 篇文献。`,
        "",
        "每个槽位已绑定证据。请为每个槽位写一句学术表述，保留 slotId 与 evidenceId：",
        "",
        ...slots.map((slot) =>
          `- ${slot.slotId} [E:${slot.evidence[0].evidenceId.slice(0, 8)}] ` +
          `(${slot.paperTitle}${slot.paperYear ? ` ${slot.paperYear}` : ""} p.${slot.pageIndex + 1}) ` +
          `«${slot.topic}»`),
      ].join("\n"),
      library: store.stats(),
    };
  }

  /**
   * Render a filled body plan into review Markdown, refusing unresolvable anchors.
   *
   * This is the enforcement half of `reviewBodyPlan`. Every sentence the caller
   * supplies must name a slot that the plan produced and at least one evidence id
   * that exists in the library *and* is one of that slot's pre-bound ids. Anything
   * else is rejected rather than rendered, because a review whose anchors do not
   * resolve is worse than no review: it reads as sourced while being unverifiable.
   *
   * Sentences with no evidence are not silently dropped either — they go into a
   * separate "needs evidence" list that the export shows, so the gap is visible
   * instead of absent.
   *
   * @param {PaperScope} paperToolScope
   * @param {{section?: string,
   *          sentences: Array<{slotId?: string, text: string, evidenceIds?: string[]}>}} input
   */
  async renderBody(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const incoming = Array.isArray(input?.sentences) ? input.sentences : [];
    if (incoming.length === 0) {
      throw new RemoteError("paper-tool/empty-body", "no sentences were supplied");
    }

    // Rebuild the plan so slot -> allowed evidence can be checked without trusting
    // the caller to echo the bindings it was given.
    const plan = await this.reviewBodyPlan(paperToolScope, { limit: 500 });
    if (!plan.ok) {
      return { ok: false, reason: plan.reason, sentences: [], unsupported: [] };
    }
    const slotById = new Map(plan.slots.map((slot) => [slot.slotId, slot]));
    const allowed = new Map(plan.slots.map((slot) => [slot.slotId, new Set(slot.evidence.map((e) => e.evidenceId))]));

    const accepted = [];
    const unsupported = [];
    const rejected = [];
    for (const raw of incoming) {
      const text = typeof raw?.text === "string" ? raw.text.trim() : "";
      if (text === "") {
        rejected.push({ text: "", reason: "empty sentence" });
        continue;
      }
      const slotId = typeof raw?.slotId === "string" ? raw.slotId.trim() : "";
      const slot = slotById.get(slotId);
      if (slot === undefined) {
        // Unknown slot means the caller is writing free sentences, which is exactly
        // the failure mode this whole design exists to prevent.
        rejected.push({ slotId, text, reason: `unknown slot: ${slotId === "" ? "(missing slotId)" : slotId}` });
        continue;
      }
      // Distinguish "caller said nothing" from "caller said none".
      //
      // Omitting `evidenceIds` means "use the slot's own binding", which is the
      // common case. Passing an explicit empty array means "this sentence has no
      // source" — a different statement, and one the caller makes deliberately to
      // get the sentence into the needs-evidence list. Treating `[]` as "use the
      // default" silently re-attached evidence to a sentence whose author had just
      // said it had none, which is the quietest possible way to fabricate support.
      const ids = Array.isArray(raw?.evidenceIds)
        ? raw.evidenceIds.filter((id) => typeof id === "string")
        : slot.evidence.map((e) => e.evidenceId);
      if (ids.length === 0) {
        unsupported.push({ slotId, text });
        continue;
      }
      const permitted = allowed.get(slotId);
      const bad = ids.filter((id) => !permitted.has(id));
      if (bad.length > 0) {
        // Anchoring a sentence to evidence that belongs to a different slot is the
        // subtle version of inventing a citation: the id resolves, but it does not
        // support this sentence. Caught here, not downstream.
        rejected.push({
          slotId,
          text,
          reason: `evidence not bound to this slot: ${bad.join(", ")}`,
          allowed: [...permitted],
        });
        continue;
      }
      // Resolve every anchor against the library as it stands now. The plan is
      // rebuilt per call, but the library can change between calls, so this is a
      // real check, not a formality.
      const rows = store.evidenceByIds(ids, { limit: 100 });
      const found = new Set(rows.map((row) => row.evidenceId));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        rejected.push({ slotId, text, reason: `evidence no longer exists: ${missing.join(", ")}` });
        continue;
      }
      accepted.push({
        slotId,
        text,
        // Full provenance per anchor: title, page, char offsets. `charStart` is what
        // lets a reader jump to the exact characters in the stored page text.
        anchors: rows.map((row) => {
          const paper = store.getPaper(row.paperId);
          return {
            evidenceId: row.evidenceId,
            paperId: row.paperId,
            paperTitle: paper?.title ?? row.paperTitle ?? row.paperId,
            pageIndex: row.pageIndex,
            charStart: row.charStart,
            charEnd: row.charEnd,
            quote: row.quote,
          };
        }),
      });
    }

    const section = (typeof input?.section === "string" && input.section.trim() !== ""
      ? input.section.trim()
      : plan.section) || "综述正文";

    const lines = accepted.map((sentence) => {
      const tags = sentence.anchors.map((a) => `[E:${a.evidenceId.slice(0, 8)}]`).join("");
      return `${sentence.text}${tags}`;
    });

    return {
      ok: true,
      section,
      sentences: accepted,
      unsupported,
      rejected,
      markdown: lines.join("\n\n"),
      summary: {
        accepted: accepted.length,
        unsupported: unsupported.length,
        rejected: rejected.length,
        slots: plan.slots.length,
      },
    };
  }

  /**
   * Review outline: evidence grouped by paper, with page anchors.
   *
   * Deliberately not prose. Generating sentences is the model's job; this
   * returns the grounded material and its provenance so the model cannot
   * invent a citation.
   */
  async reviewOutline(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const rows = store.evidenceByPaper({ limit: clampInt(input?.limit, 2000, 1, 5000) });
    const groups = [];
    const index = new Map();
    for (const row of rows) {
      let group = index.get(row.paperId);
      if (group === undefined) {
        const paper = store.getPaper(row.paperId);
        group = {
          paperId: row.paperId,
          title: row.paperTitle ?? paper?.title ?? row.paperId,
          year: paper?.year ?? "",
          authors: paper?.authors ?? "",
          evidenceCount: 0,
          items: [],
        };
        index.set(row.paperId, group);
        groups.push(group);
      }
      group.evidenceCount += 1;
      group.items.push({
        evidenceId: row.evidenceId,
        pageIndex: row.pageIndex,
        quote: row.quote,
      });
    }
    if (groups.length === 0) {
      return {
        groups: [],
        text:
          store.stats().papers === 0
            ? "库是空的：先导入 PDF，再用 paper_evidence 收集证据。"
            : `库里已有 ${store.stats().papers} 篇文献，但还没有证据条目。先用 paper_evidence（action=collect）收集。`,
      };
    }
    const lines = groups.map((group) => {
      const head = `${group.title}${group.year ? ` (${group.year})` : ""} — ${group.evidenceCount} 条证据`;
      const items = group.items
        .map((item) => `    · p.${item.pageIndex + 1} [${item.evidenceId.slice(0, 8)}] "${truncate(item.quote, 180)}"`)
        .join("\n");
      return `- ${head}\n${items}`;
    });
    return {
      groups,
      text: `证据大纲：${groups.length} 篇文献，${rows.length} 条证据\n\n${lines.join("\n")}`,
    };
  }

  /**
   * Evidence matrix: for one claim, which papers support, conflict, or say
   * nothing. "not_found" is an answer, not a failure — a review that only
   * reports agreement is not a review.
   */
  async reviewMatrix(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const claim = typeof input?.claim === "string" ? input.claim.trim() : "";
    const requestedStance = STANCES.includes(input?.stance) ? input.stance : null;
    const scopeIds = Array.isArray(input?.evidenceIds) && input.evidenceIds.length > 0
      ? new Set(input.evidenceIds.filter((id) => typeof id === "string"))
      : null;
    // Same reasoning as formatCitations: once evidence is paged in the UI, a
    // scope built from the client's loaded ids is a partial scope. Let the caller
    // ask for "all anchored evidence" so the matrix stays complete.
    const anchor = input?.anchor === "anchored" ? "anchored" : "all";
    const rows = [];
    const papers = store.listPapers({ limit: 2000 });
    const evidenceRows = scopeIds === null
      ? store.listEvidence({ limit: 2000, anchor })
      : store.evidenceByIds([...scopeIds], { limit: 2000 });
    const byPaper = new Map();
    for (const row of evidenceRows) {
      if (!byPaper.has(row.paperId)) byPaper.set(row.paperId, []);
      byPaper.get(row.paperId).push(row);
    }

    // With no claim there is nothing to judge, so the matrix degrades to a
    // coverage table: "does this paper have evidence at all". Reporting
    // support/not_found here would be a stance judgement nobody asked for.
    const coverageOnly = claim === "";
    for (const paper of papers) {
      const items = byPaper.get(paper.paperId) ?? [];
      const support = [];
      const conflict = [];
      const notFound = [];
      // Per-evidence judgements, kept so the matrix can show its work. An
      // evidence row that is neither cited nor explained is a number the user
      // has to take on faith, which is what this task removes.
      const judgements = [];
      if (coverageOnly) {
        for (const item of items) support.push(item);
      } else {
        for (const item of items) {
          // The judgement is a separate, testable module (lib/stance.js) rather
          // than an inline heuristic: the old code could only be checked by
          // reading it, and it graded every overlap as full support.
          const judgement = judgeStance(claim, item.quote);
          judgements.push({ evidenceId: item.evidenceId, ...judgement });
          if (judgement.stance === "conflict") conflict.push(item);
          else if (judgement.stance === "support") support.push(item);
          else notFound.push(item);
        }
      }
      // "no evidence collected" and "evidence exists but none of it addresses
      // the claim" are different findings: the first is a gap in the corpus
      // work, the second is the literature being silent. Collapsing them into
      // one not_found hides which one the reviewer has to act on.
      const stance = coverageOnly
        ? items.length > 0
          ? "covered"
          : "empty"
        : conflict.length > 0
          ? "conflict"
          : support.length > 0
            ? "support"
            : items.length > 0
              ? "not_found"
              : "no_evidence";
      if (requestedStance !== null && stance !== requestedStance) continue;
      // The paper-level strength is the strongest single judgement behind it.
      // Averaging would let one strong quote be diluted by several weak ones,
      // and the user wants to know whether *anything* here is firm.
      const strength = coverageOnly
        ? null
        : judgements.reduce((best, entry) => {
            const rank = { strong: 2, partial: 1, weak: 0 };
            if (best === null || rank[entry.strength] > rank[best]) return entry.strength;
            return best;
          }, null);
      rows.push({
        paperId: paper.paperId,
        title: paper.title || paper.paperId,
        year: paper.year,
        stance,
        strength,
        evidenceIds: [...support, ...conflict].map((item) => item.evidenceId),
        // Without this the "not mentioned" rows show a count but offer no way
        // back to the passages that produced it.
        notFoundEvidenceIds: notFound.map((item) => item.evidenceId),
        supportCount: support.length,
        conflictCount: conflict.length,
        notFoundCount: notFound.length,
        // The graded per-evidence judgements behind this row's stance. A row
        // that says "supports" without showing which quote and why is exactly
        // the unverifiable claim this task exists to remove.
        judgements,
      });
    }

    const counts = coverageOnly
      ? {
          covered: rows.filter((row) => row.stance === "covered").length,
          empty: rows.filter((row) => row.stance === "empty").length,
        }
      : {
          support: rows.filter((row) => row.stance === "support").length,
          conflict: rows.filter((row) => row.stance === "conflict").length,
          not_found: rows.filter((row) => row.stance === "not_found").length,
          no_evidence: rows.filter((row) => row.stance === "no_evidence").length,
          // How firm the support is, not just how much of it there is. Ten weak
          // supports are not the same finding as one strong support, and the
          // flat counts made them look identical.
          strong: rows.filter((row) => row.stance === "support" && row.strength === "strong").length,
          partial: rows.filter((row) => row.stance === "support" && row.strength === "partial").length,
          weak: rows.filter((row) => row.stance === "support" && row.strength === "weak").length,
        };
    if (rows.length === 0) {
      return { rows, counts, text: claim === "" ? "库里还没有文献。" : `没有文献匹配该论断的证据分组。` };
    }
    const label = (stance) =>
      stance === "support"
        ? "支持"
        : stance === "conflict"
          ? "冲突"
          : stance === "covered"
            ? "有证据"
            : stance === "empty"
              ? "无证据"
              : stance === "no_evidence"
                ? "未收集证据"
                : "未提及";
    const strengthLabel = (value) =>
      value === "strong" ? "强" : value === "partial" ? "部分" : value === "weak" ? "弱" : "";
    const lines = rows.map((row) => {
      const grade = row.strength === null || row.strength === undefined ? "" : `（${strengthLabel(row.strength)}）`;
      return `- ${label(row.stance)}${grade} · ${row.title}${row.year ? ` (${row.year})` : ""} — ${row.supportCount + row.conflictCount} 条证据`;
    });
    const summary = coverageOnly
      ? `有证据 ${counts.covered} 篇 · 无证据 ${counts.empty} 篇`
      : `支持 ${counts.support} 篇（强 ${counts.strong} / 部分 ${counts.partial} / 弱 ${counts.weak}） · 冲突 ${counts.conflict} 篇 · 未提及 ${counts.not_found} 篇`;
    return {
      rows,
      counts,
      coverageOnly,
      text: `${coverageOnly ? "证据覆盖矩阵（未给论断，故不判定支持或冲突）" : `论断：「${truncate(claim, 120)}」`}\n${summary}\n\n${lines.join("\n")}`,
    };
  }

  /**
   * Serve one pdfjs asset (CMap or standard font) to the browser reader.
   *
   * CJK PDFs need their CMaps to render at all, and they are 169 separate
   * files, so they are fetched individually through the authenticated channel
   * rather than bundled into the runtime response.
   */
  async getPdfAsset(paperToolScope, input, signal) {
    assertScope(paperToolScope);
    return await readPdfjsAsset(requiredString(input?.kind, "kind"), requiredString(input?.name, "name"), signal);
  }

  /**
   * Search external free sources (OpenAlex / Crossref / arXiv) for candidates.
   *
   * Read-only: nothing enters the library until `importCandidates` is called,
   * so a broad search cannot pollute the user's corpus.
   */
  async searchExternal(paperToolScope, input, signal) {
    assertScope(paperToolScope);
    // Touch the store so an unwritable workspace fails here, not mid-import.
    this.storeFor(paperToolScope);
    const result = await searchExternalQuery(input?.query, {
      limit: clampInt(input?.limit, 10, 1, 50),
      sources: Array.isArray(input?.sources) ? input.sources : undefined,
      // Only the three known modes are accepted; anything else falls back to relevance
      // rather than being passed through, so a typo cannot silently change the ranking.
      sort: input?.sort === "citations" || input?.sort === "year" ? input.sort : "relevance",
      signal,
    });
    return result;
  }

  /** Store chosen external candidates as metadata-only papers. */
  async addCandidates(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
    if (candidates.length === 0) {
      throw new RemoteError("paper-tool/no-candidates", "no candidates to add");
    }
    // Sanitise: a client must not be able to set arbitrary internal fields.
    const clean = candidates
      .filter((candidate) => typeof candidate?.title === "string" && candidate.title.trim() !== "")
      .slice(0, 100)
      .map((candidate) => ({
        title: candidate.title.trim().slice(0, 1000),
        authors: String(candidate.authors ?? "").slice(0, 1000),
        year: String(candidate.year ?? "").slice(0, 20),
        venue: String(candidate.venue ?? "").slice(0, 500),
        doi: String(candidate.doi ?? "").slice(0, 300),
        abstract: String(candidate.abstract ?? "").slice(0, 4000),
        source: String(candidate.source ?? "external").slice(0, 40),
      }));
    const added = importCandidates(store, clean);
    return { ...added, library: store.stats() };
  }

  /** Report CNKI connection state without opening a browser window. */
  async cnkiStatus(paperToolScope) {
    assertScope(paperToolScope);
    return await cnkiStatus();
  }

  /**
   * Open the CNKI session browser.
   *
   * Visible by design: the one manual step is the user's own login, and a hidden
   * window would make that impossible. Safe to call repeatedly.
   */
  async cnkiConnect(paperToolScope) {
    assertScope(paperToolScope);
    return await cnkiConnect({ visible: true });
  }

  /** Close the CNKI browser, keeping the saved profile so login survives. */
  async cnkiDisconnect(paperToolScope) {
    assertScope(paperToolScope);
    return await cnkiDisconnect();
  }

  /** Search CNKI through the logged-in browser session. */
  async cnkiSearch(paperToolScope, input, signal) {
    assertScope(paperToolScope);
    const query = requiredString(input?.query, "query").trim();
    if (query === "") throw new RemoteError("paper-tool/empty-query", "query is empty");
    return await cnkiSearch({ query, limit: clampInt(input?.limit, 20, 1, 50), signal });
  }

  /**
   * Download a CNKI record's PDF and ingest it, in one step.
   *
   * The download is verified to be a real PDF before it enters the library, so
   * a saved login page never becomes a "paper".
   */
  async cnkiDownload(paperToolScope, input, signal) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const href = requiredString(input?.href, "href");
    // This URL drives a browser that holds the user's live CNKI session, so it
    // must not be able to point anywhere else. Without this check a caller can
    // navigate an authenticated tab to any origin and import the result as a
    // "paper".
    if (!isCnkiUrl(href)) {
      return { ok: false, reason: "refusing to navigate a logged-in browser outside cnki.net" };
    }
    const download = await cnkiDownloadPdf({ href, signal });
    if (!download.ok) return download;
    const bytes = await readFile(download.path);
    const imported = await this.importPdf(paperToolScope, {
      files: [
        {
          name:
            typeof input?.title === "string" && input.title !== ""
              ? `${input.title.slice(0, 80)}.pdf`
              : basename(download.path),
          data: new Uint8Array(bytes),
          title: typeof input?.title === "string" ? input.title : "",
          authors: typeof input?.authors === "string" ? input.authors : "",
          year: typeof input?.year === "string" ? input.year : "",
          venue: typeof input?.venue === "string" ? input.venue : "",
        },
      ],
    });
    // The download copy is a staging artifact; the library holds its own bytes.
    await unlink(download.path).catch(() => {});
    return { ok: true, bytes: download.bytes, ...imported };
  }

  /** Render a bibliography in the requested CSL style, from stored metadata. */
  async formatCitations(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const styleId = typeof input?.style === "string" && input.style !== "" ? input.style : "apa";
    const requestedLocale = typeof input?.locale === "string" && input.locale !== "" ? input.locale : "en-US";
    // `anchor: "anchored"` lets the caller ask for "everything citable" instead
    // of naming ids. This matters now that the client loads evidence in pages: a
    // bibliography built from the ids on page one would silently omit the rest,
    // and a citation list that is quietly incomplete is worse than an error.
    const anchor = input?.anchor === "anchored" ? "anchored" : "all";
    const papers = store.papersForEvidence({ evidenceIds: input?.evidenceIds, anchor });
    if (papers.length === 0) {
      return {
        ok: false,
        styleId,
        locale: requestedLocale,
        bibliography: "",
        citation: "",
        entries: [],
        text: "还没有可引用的证据条目，先收集证据。",
      };
    }
    const rendered = await renderBibliography(papers, styleId, requestedLocale);
    const entries = papers.map((paper) => ({
      paperId: paper.paperId,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      doi: paper.doi,
    }));
    const warnings = [...(rendered.warnings ?? [])];
    return {
      ok: rendered.ok,
      styleId: rendered.styleId,
      // Report the locale actually used, not the one requested: a silent
      // substitution would make the interface claim a language it never
      // rendered.
      locale: rendered.locale ?? normalizeLocale(requestedLocale) ?? "en-US",
      reason: rendered.reason,
      bibliography: rendered.bibliography,
      citation: rendered.citation,
      warnings,
      entries,
      text: rendered.ok
        ? `参考文献（${rendered.styleId}）：\n${rendered.bibliography}\n\n正文引用：${rendered.citation}`
        : `无法渲染 ${rendered.styleId}：${rendered.reason}`,
    };
  }

  /**
   * Import PDFs into the library and index their text.
   *
   * Bytes are persisted under the workspace before indexing, because the
   * sidebar reader re-reads the original file per page session: without a
   * stored copy `readPaperBytes` has nothing to serve.
   *
   * @param {PaperScope} paperToolScope
   * @param {{files: {name: string, data: Uint8Array|number[]}[]}} input
   */
  async importPdf(paperToolScope, input, signal) {
    assertScope(paperToolScope);
    const files = Array.isArray(input?.files) ? input.files : [];
    if (files.length === 0) {
      throw new RemoteError("paper-tool/no-files", "importPdf requires at least one file");
    }
    // Over the per-call cap is no longer a rejection. A folder import of 200
    // papers is a normal thing to attempt, and refusing it wholesale left the
    // user with nothing but an error. The first MAX_IMPORT_FILES are processed and
    // the rest are reported as `remaining` so the client can say exactly what
    // happened and offer to continue.
    //
    // Still capped per call rather than lifted entirely: one RPC carrying 200
    // PDFs as JSON byte arrays is hundreds of megabytes through a single
    // message, which is the failure mode this bound exists for.
    const accepted = files.slice(0, MAX_IMPORT_FILES);
    const remaining = files.length - accepted.length;
    const store = this.storeFor(paperToolScope);
    const filesDir = this.filesDir(paperToolScope);
    await mkdir(filesDir, { recursive: true });
    const imported = [];
    const duplicates = [];
    const failed = [];

    for (const file of accepted) {
      const name = typeof file?.name === "string" ? basename(file.name) : "untitled.pdf";
      try {
        // Checked at the top of the per-file iteration, which is the granularity that
        // actually exists: once extractPdfPages or OCR starts on one file, the work
        // runs to completion. The catch below turns this into a partial result rather
        // than a failure.
        signal?.throwIfAborted();
        const bytes = toUint8(file?.data);
        if (bytes.byteLength === 0) throw new Error("empty file");
        if (bytes.byteLength > MAX_PDF_BYTES) {
          throw new Error(`exceeds the ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB import cap`);
        }
        const extracted = await extractPdfPages(bytes);
        // Pass everything the PDF knows about itself, plus the file name: a
        // Zotero/CNKI name is a citation in disguise and survives whatever
        // mangled the PDF. Without this the metadata was guessed from prose alone.
        const guess = guessMetadata(extracted.pages, {
          info: extracted.info,
          xmp: extracted.xmp,
          layout: extracted.layout,
          filename: name,
        });
        const pageCount = extracted.pages.filter((page) => page.trim() !== "").length;
        // Re-importing a file the library already holds must not create a second
        // entry: same bytes, same fingerprint, same paper. This check runs BEFORE
        // OCR on purpose — recognition costs about a second per page, and paying
        // that to then discover the paper is already in the library would make a
        // redundant drop of a 40-page scan take a minute for nothing.
        const existing = store.findByFingerprint(extracted.fingerprint);
        if (existing !== null) {
          duplicates.push({
            paperId: existing.paperId,
            title: existing.title,
            numPages: existing.numPages,
            fingerprint: extracted.fingerprint,
            filename: name,
          });
          continue;
        }
        // A PDF with no text layer is a scan. Recover its text with OCR so the
        // paper is actually searchable instead of sitting there as metadata
        // only. This is best-effort by design: an unavailable engine must not
        // fail the import, it must make the result honest about what it holds.
        const ocr = pageCount === 0 && input?.ocr !== false ? await this.#runOcr(bytes, extracted, signal) : null;
        const pages = ocr?.pages ?? extracted.pages;
        const indexablePages = pages.filter((page) => page.trim() !== "").length;
        const paperId = randomUUID();
        // Keep the original bytes: the reader and any re-index come from here.
        const pdfPath = join(filesDir, `${paperId}.pdf`);
        await writeFile(pdfPath, bytes);
        const paper = store.upsertPaper({
          paperId,
          // Each field: an explicit value from the caller wins, otherwise use what
          // the PDF says about itself. `authors` and `venue` used to read only from
          // `file.*`, which the import path never populates — so both were
          // permanently empty and the user saw "journal name not recognised".
          title: typeof file.title === "string" && file.title !== "" ? file.title : guess.title,
          authors: typeof file.authors === "string" && file.authors !== "" ? file.authors : guess.authors,
          year: typeof file.year === "string" && file.year !== "" ? file.year : guess.year,
          venue: typeof file.venue === "string" && file.venue !== "" ? file.venue : guess.venue,
          doi: typeof file.doi === "string" && file.doi !== "" ? file.doi : guess.doi,
          abstract: typeof file.abstract === "string" ? file.abstract : "",
          source: "import",
          // Keep the original file name: it is a citation in disguise on
          // Zotero/CNKI exports, and re-extraction needs it to match what the
          // import could already see.
          sourceName: name,
          pdfPath,
          fingerprint: extracted.fingerprint,
          // Provenance, so the UI can mark exactly the fields that are guesses.
          metadataSource: JSON.stringify(guess.sources ?? {}),
          // Honest coverage: OCR text is machine-guessed, so it is "ocr", not
          // "fulltext". A PDF with neither is metadata-only, and the UI must
          // show that instead of implying full text is searchable.
          material: indexablePages > 0 ? (ocr !== null ? "ocr" : "fulltext") : "metadata",
          textSource: ocr !== null ? "ocr" : "text-layer",
          pages,
          pageSources: ocr?.pageSources ?? [],
        });
        imported.push({
          paperId: paper.paperId,
          title: paper.title,
          numPages: paper.numPages,
          pagesWithText: indexablePages,
          fingerprint: extracted.fingerprint,
          material: paper.material,
          textSource: paper.textSource,
          filename: name,
          // Say out loud what OCR did or why it did not run, so a scanned import
          // never looks like a silent success.
          ...(ocr !== null
            ? {
                ocr: {
                  language: ocr.language,
                  pagesRecognised: ocr.pagesRecognised,
                  pagesFailed: ocr.pagesFailed,
                },
              }
            : pageCount === 0
              ? { ocr: { skipped: true, reason: this.ocrSkipReason } }
              : {}),
        });
        // Enrich from Crossref right after the row exists, so a freshly imported
        // paper already has authors and a venue. Doing it here rather than behind a
        // "fix my metadata" button is deliberate: the extractor cannot read authors
        // off a typeset page, so *every* import would otherwise need the user to
        // notice the problem and act. Best-effort by design — an offline user still
        // gets a usable import, just with the PDF-derived guesses.
        if (input?.enrich !== false) {
          const enrichment = await this.#enrichOne(store, paper.paperId);
          // Report the outcome honestly: "enriched" only when a field actually
          // changed, and the reason when it did not, so a network-less import is
          // visibly not enriched rather than silently unimproved.
          const target = imported[imported.length - 1];
          if (enrichment.changed.length > 0) {
            target.enriched = enrichment.changed;
            const refreshed = store.getPaper(paper.paperId);
            if (refreshed !== null) {
              target.title = refreshed.title;
              target.authors = refreshed.authors;
              target.venue = refreshed.venue;
              target.year = refreshed.year;
            }
          } else if (enrichment.reason !== undefined) {
            target.enrichSkipped = enrichment.reason;
          }
        }
        signal?.throwIfAborted();
      } catch (error) {
        // A cancellation is not a failure. Let it escape the per-file loop: the        // caller pressed stop, so the correct result is an aborted call carrying the
        // files already imported — not a `failed` entry that says "Import aborted"
        // next to a paper that imported perfectly well. This is the difference
        // between "the import broke" and "you stopped the import".
        if (isAbortError(error)) {
          if (imported.length === 0 && duplicates.length === 0) throw error;
          return {
            imported,
            duplicates,
            failed,
            aborted: true,
            skipped: files.length - imported.length - duplicates.length - failed.length,
            library: store.stats(),
          };
        }
        // The fingerprint index is the real idempotency guarantee: two
        // concurrent imports both pass the check above, and the loser lands
        // here. Report it as a duplicate rather than as a failure.
        if (/UNIQUE constraint failed/i.test(String(error?.message ?? ""))) {
          duplicates.push({ filename: name, title: name, reason: "already in the library" });
          continue;
        }
        failed.push({ filename: name, reason: error?.message ?? String(error) });
      }
    }
    return {
      imported,
      duplicates,
      failed,
      library: store.stats(),
      // How many files this call did NOT process because of the per-call cap.
      // Reported rather than silently dropped: a folder import of 41 files that
      // quietly imports 32 and says "32 imported" is indistinguishable from a
      // folder that only had 32 files in it.
      remaining,
      limit: MAX_IMPORT_FILES,
    };
  }

  /**
   * Start watching one folder for new PDFs.
   *
   * Opt-in by construction: this method is the only way a watcher is ever
   * created, and the client only calls it when the user turns the switch on.
   * There is no "watch on startup" path.
   *
   * @param {PaperScope} paperToolScope
   * @param {{ dir: string }} input
   */
  async watchStart(paperToolScope, input) {
    assertScope(paperToolScope);
    const dir = requiredString(input?.dir, "dir");
    const info = await stat(dir).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new RemoteError("paper-tool/no-such-dir", `not a directory: ${dir}`);
    }
    // One folder at a time. Two watchers writing into the same library would race
    // on the same fingerprint check and could both import the same file.
    if (this.watchState !== null) await this.watchStop(paperToolScope, {});

    const store = this.storeFor(paperToolScope);
    const filesDir = this.filesDir(paperToolScope);
    await mkdir(filesDir, { recursive: true });

    const settle = new SettleTracker({ quietMs: 1500 });
    // Paths already imported or already known. A rewrite of the same file emits
    // more events; without this the second event would import a duplicate row
    // even though the fingerprint check would catch the bytes, because the entry
    // is keyed on path rather than content.
    const seen = new Set();

    const importOne = async (path) => {
      try {
        const bytes = new Uint8Array(await readFile(path));
        const outcome = await this.importPdf(paperToolScope, {
          files: [{ name: basename(path), data: Array.from(bytes) }],
        });
        state.imported += outcome.imported.length;
        state.duplicates += outcome.duplicates.length;
        if (outcome.failed.length > 0) state.failed += outcome.failed.length;
        return outcome;
      } catch (error) {
        // Not counted as a failure yet: a file can be unreadable for a moment and
        // then fine. Recording it as failed is what turns a watch folder into a
        // log of noise.
        state.lastError = error instanceof Error ? error.message : String(error);
        return null;
      }
    };

    /** @type {any} */
    const state = {
      dir, sessionId: paperToolScope.sessionId, settle, seen,
      imported: 0, failed: 0, duplicates: 0, lastError: null,
      timer: null,
      watcher: null,
    };

    // fs.watch is only a trigger. It reports that *something* happened; deciding
    // whether the file has settled is the tracker's job, polled below.
    state.watcher = fsWatch(dir, { persistent: false }, () => {
      // Intentionally empty: the poll below is what decides. Reacting here would
      // mean trusting an event that fires mid-write.
    });
    // A watcher that throws (deleted folder, permissions) must stop, not spin.
    state.watcher.on("error", (error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
    });

    // Poll for stability. fs.watch says "it changed"; only sampling over time can
    // say "it stopped changing", and a PDF copied in over a second produces a
    // change event per buffer flush.
    state.timer = setInterval(async () => {
      if (this.watchState !== state) return;
      let names;
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!isPdfName(name) || seen.has(name)) continue;
        const path = join(dir, name);
        const info = await stat(path).catch(() => null);
        if (info === null || !info.isFile()) continue;
        const sample = { size: info.size, mtimeMs: info.mtimeMs };
        if (settle.offer(path, sample)) {
          seen.add(name);
          await importOne(path);
        }
      }
    }, 500);
    if (typeof state.timer.unref === "function") state.timer.unref();

    this.watchState = state;
    return await this.watchStatus(paperToolScope, {});
  }

  /**
   * Stop watching. Safe to call when nothing is being watched.
   *
   * @param {PaperToolScope} paperToolScope
   */
  async watchStop(paperToolScope) {
    assertScope(paperToolScope);
    const state = this.watchState;
    if (state === null) return { watching: false, dir: null };
    this.watchState = null;
    try { state.watcher.close(); } catch { /* already gone */ }
    if (state.timer !== null) clearInterval(state.timer);
    state.settle.reset();
    return { watching: false, dir: null, imported: state.imported, duplicates: state.duplicates, failed: state.failed };
  }

  /**
   * Report the watch state without changing it.
   *
   * @param {PaperToolScope} paperToolScope
   */
  async watchStatus(paperToolScope) {
    assertScope(paperToolScope);
    const state = this.watchState;
    // Default off, and say so explicitly: "watching: false" with no dir is the
    // ordinary state, not an error the caller has to interpret.
    if (state === null) {
      return { watching: false, dir: null, imported: 0, duplicates: 0, failed: 0, lastError: null, pending: 0 };
    }
    return {
      watching: true,
      dir: state.dir,
      imported: state.imported,
      duplicates: state.duplicates,
      failed: state.failed,
      lastError: state.lastError,
      pending: state.settle.size,
    };
  }

  /**
   * Cut a paper's page text into translation-ready segments.
   *
   * The plugin cannot translate (D-014), so this method's entire job is to make
   * translation *possible* for the Agent: return the original text in pieces that
   * are small enough to translate and precise enough to write back against.
   *
   * Returning the whole page instead would leave the Agent to invent its own
   * boundaries, and the write-back would then have no anchor to attach to — the
   * side-by-side view would have to pair by position, which breaks the moment one
   * paragraph is skipped.
   *
   * @param {PaperToolScope} paperToolScope
   * @param {{paperId: string, fromPage?: number, toPage?: number, maxChars?: number, targetLang?: string}} input
   */
  async translateSegments(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    const paper = store.getPaper(paperId);
    if (paper === null) throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    const totalPages = Number(paper.numPages) || 0;
    const fromPage = Math.max(0, clampInt(input?.fromPage, 0, 0, Math.max(0, totalPages - 1)));
    const toPage = Math.max(fromPage, clampInt(input?.toPage, fromPage, fromPage, Math.max(0, totalPages - 1)));

    const segments = [];
    for (let pageIndex = fromPage; pageIndex <= toPage; pageIndex += 1) {
      const page = store.getPage(paperId, pageIndex);
      if (page === null) continue;
      const pageSegments = splitPageSegments(page.text ?? "", pageIndex, { maxChars: input?.maxChars });
      // The page's OCR provenance travels with each segment. A translation of
      // guessed text compounds the guessing, and the reader has to be able to see
      // that rather than trusting the译文 as if it were the paper's own words.
      for (const segment of pageSegments) {
        segments.push({ ...segment, textSource: page.textSource ?? "text-layer", material: paper.material ?? "" });
      }
    }
    const translations = store.listTranslations({ paperId, targetLang: input?.targetLang });
    const aligned = alignSegments(
      segments.map((segment) => ({ pageIndex: segment.pageIndex, charStart: segment.charStart, charEnd: segment.charEnd, text: segment.text })),
      translations,
      { targetLang: input?.targetLang },
    );
    return {
      paperId,
      title: paper.title,
      fromPage,
      toPage,
      totalPages,
      targetLang: input?.targetLang ?? "",
      segments,
      // Pairing is by anchor, so this tells the caller exactly which paragraphs are
      // still untranslated instead of only how many.
      translated: aligned.pairs.filter((pair) => pair.translation !== null).length,
      untranslated: aligned.unmatchedSource.length,
      aligned: aligned.aligned,
      // Said out loud because it changes how the output must be read.
      // One entry per page, not per segment: a scanned page has several segments and
      // a repeated page number reads like a bug in the report.
      ocrPages: [...new Set(segments.filter((segment) => segment.textSource === "ocr").map((segment) => segment.pageIndex))],
    };
  }

  /**
   * Store translations against the anchors they were produced from.
   *
   * Takes an array so one round-trip can carry a whole page. Each item must name its
   * own offsets; an item without them is rejected rather than matched positionally,
   * because positional matching would attach a translation to the wrong paragraph
   * the first time the Agent skipped one.
   *
   * @param {PaperToolScope} paperToolScope
   * @param {{paperId: string, targetLang?: string, sourceLang?: string, items: Array<{pageIndex: number, charStart: number, charEnd: number, text: string, sourceText?: string}>}} input
   */
  async saveTranslation(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    if (store.getPaper(paperId) === null) {
      throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    }
    const items = Array.isArray(input?.items) ? input.items : [];
    if (items.length === 0) {
      throw new RemoteError("paper-tool/no-items", "saveTranslation requires at least one item");
    }
    const saved = [];
    const rejected = [];
    for (const item of items) {
      const pageIndex = Number(item?.pageIndex);
      const charStart = Number(item?.charStart);
      const charEnd = Number(item?.charEnd);
      const text = typeof item?.text === "string" ? item.text : "";
      if (!Number.isInteger(pageIndex) || pageIndex < 0
        || !Number.isInteger(charStart) || charStart < 0
        || !Number.isInteger(charEnd) || charEnd <= charStart) {
        rejected.push({ reason: "missing or invalid anchor", item });
        continue;
      }
      if (text.trim() === "") {
        rejected.push({ reason: "empty translation", item });
        continue;
      }
      const page = store.getPage(paperId, pageIndex);
      if (page === null) {
        rejected.push({ reason: `no such page: ${pageIndex}`, item });
        continue;
      }
      // The stored source is what the page holds now, not what the caller claims to
      // have translated: the paper's words are the only authority on its own words.
      const sourceText = (page.text ?? "").slice(charStart, charEnd);
      const row = store.saveTranslation({
        translationId: randomUUID(),
        paperId,
        pageIndex,
        charStart,
        charEnd,
        sourceLang: input?.sourceLang ?? "",
        targetLang: input?.targetLang ?? "",
        sourceText,
        text,
      });
      saved.push(row);
    }
    return {
      paperId,
      saved: saved.length,
      rejected,
      translations: saved,
      // Reported so the caller can see the side-by-side view will be whole.
      aligned: (await this.translateSegments(paperToolScope, { paperId, targetLang: input?.targetLang })).aligned,
    };
  }

  /**
   * Read back stored translations, paired with their source segments.
   *
   * @param {PaperToolScope} paperToolScope
   * @param {{paperId: string, fromPage?: number, toPage?: number, targetLang?: string}} input
   */
  async listTranslations(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    if (store.getPaper(paperId) === null) {
      throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    }
    const rows = store.listTranslations({ paperId, targetLang: input?.targetLang });
    const fromPage = Number.isInteger(input?.fromPage) ? input.fromPage : null;
    const toPage = Number.isInteger(input?.toPage) ? input.toPage : null;
    const filtered = rows.filter((row) => (fromPage === null || row.pageIndex >= fromPage)
      && (toPage === null || row.pageIndex <= toPage));
    return {
      paperId,
      targetLang: input?.targetLang ?? "",
      translations: filtered,
      total: store.countTranslations({ paperId }),
    };
  }

  /**
   * Delete one stored translation.
   *
   * @param {PaperToolScope} paperToolScope
   * @param {{translationId: string}} input
   */
  async deleteTranslation(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const translationId = requiredString(input?.translationId, "translationId");
    const existing = store.listTranslations({ limit: 5000 }).find((row) => row.translationId === translationId);
    if (existing === undefined) {
      throw new RemoteError("paper-tool/translation-not-found", "no such translation");
    }
    store.deleteTranslation(translationId);
    return { deleted: translationId, paperId: existing.paperId };
  }

  /**
   * Edit bibliographic metadata after import.
   *
   * PDF metadata guesses are frequently wrong (a first page header becomes the
   * title, the arXiv stamp becomes the year). Citations are only as good as
   * these fields, so the user must be able to correct them.
   */
  async updatePaper(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    if (store.getPaper(paperId) === null) {
      throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    }
    const bounded = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);
    const paper = store.updatePaper(paperId, {
      title: bounded(input?.title, 2000),
      authors: bounded(input?.authors, 2000),
      year: bounded(input?.year, 40),
      venue: bounded(input?.venue, 1000),
      doi: bounded(input?.doi, 300),
      abstract: bounded(input?.abstract, 20000),
    });
    return { paper, library: store.stats() };
  }

  /**
   * Re-run metadata extraction on an already-imported paper.
   *
   * The extractor only runs at import time, so every improvement to it was
   * invisible to papers already in the library — the user's own library showed
   * empty authors and journals from the old code long after the new code shipped.
   * Re-importing was the only workaround, and that creates a new row (or is
   * refused as a duplicate), so there was effectively no way to fix an existing
   * entry short of deleting and re-adding it.
   *
   * Re-extraction must not silently overwrite what the user typed. Any field the
   * user corrected was removed from `metadataSource` by `updatePaper`, so the
   * fields still listed there are the guesses that may be replaced; everything
   * else is kept as-is.
   */
  async reextractMetadata(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    const paper = store.getPaper(paperId);
    if (paper === null) throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    if (typeof paper.pdfPath !== "string" || paper.pdfPath === "") {
      throw new RemoteError(
        "paper-tool/no-pdf",
        "this paper was added as metadata only, so there is no PDF to read",
      );
    }
    let bytes;
    try {
      bytes = await readFile(paper.pdfPath);
    } catch {
      throw new RemoteError(
        "paper-tool/pdf-missing",
        "the stored PDF is no longer on disk; import the file again",
      );
    }

    const extracted = await extractPdfPages(bytes);
    // Use the stored original file name when the import kept one: it is a
    // citation in disguise on Zotero/CNKI exports ("Li - 2021 - Title.pdf"), and
    // a re-extract that drops that channel can produce worse values than the
    // import it is supposed to improve on. Rows imported before `sourceName`
    // existed fall back to the PDF's own metadata, honestly.
    const guess = guessMetadata(extracted.pages, {
      info: extracted.info,
      xmp: extracted.xmp,
      layout: extracted.layout,
      filename: typeof paper.sourceName === "string" ? paper.sourceName : "",
    });

    // Which fields may be replaced: those still marked as guesses, plus any that
    // are currently empty. A field the user typed is never touched.
    let marked = {};
    try {
      marked = JSON.parse(paper.metadataSource === "" ? "{}" : paper.metadataSource);
    } catch {
      marked = {};
    }
    const verifiedAt = typeof paper.metadataVerifiedAt === "string" ? paper.metadataVerifiedAt : "";
    // `metadataVerifiedAt` is written only by `updatePaper`'s user-edit path, so
    // a set stamp means "a human edited this row at some point", while an empty
    // one means every value came from the importer. That is the distinction the
    // guards need, and it cannot be inferred from `metadataSource` alone: rows
    // imported before v4 have an empty provenance map *and* an empty stamp, while
    // a row the user edited once has an empty map for the edited field and a
    // stamp. Verified against the real library: all four imported rows carry
    // `metadataVerifiedAt = ''`, because `upsertPaper` never writes it.
    const userEdited = verifiedAt !== "";
    const replaceable = (field) => {
      if (typeof paper[field] !== "string" || paper[field].trim() === "") return true;
      if (typeof marked[field] === "string" && marked[field] !== "") return true;
      // Nothing on this row was ever edited by hand, so an unmarked value is the
      // importer's own guess — including the wrong year that could otherwise
      // never be repaired, because it looked user-confirmed.
      if (!userEdited) return guess[field] !== "" && guess[field] !== paper[field];
      // The row has been edited, but this particular field is unmarked, so the
      // edit was to a *different* field and this one is still the importer's
      // guess. A title the OLD extractor produced by truncating the largest line
      // is still a guess, and the visible symptom the user reported — "Hotel
      // servicescape and customer" cut off mid-title — would otherwise be
      // permanent. Only a strict extension of the stored title to the new guess
      // qualifies, so a genuinely different (user-written) title is safe.
      if (field === "title" && paper.title.length >= 8 && guess.title !== "") {
        if (guess.title.startsWith(paper.title) && guess.title.length > paper.title.length) return true;
      }
      return false;
    };

    const next = {
      title: replaceable("title") && guess.title !== "" ? guess.title : paper.title,
      authors: replaceable("authors") && guess.authors !== "" ? guess.authors : paper.authors,
      year: replaceable("year") && guess.year !== "" ? guess.year : paper.year,
      venue: replaceable("venue") && guess.venue !== "" ? guess.venue : paper.venue,
      doi: replaceable("doi") && guess.doi !== "" ? guess.doi : paper.doi,
      abstract: paper.abstract,
    };

    const changed = {};
    for (const field of ["title", "authors", "year", "venue", "doi"]) {
      if (next[field] !== paper[field]) changed[field] = { before: paper[field], after: next[field] };
    }
    // Fields the guards refused to repair but that the extractor disagrees with.
    // Surfacing them lets the UI say "we found a better value but kept yours"
    // instead of pretending the stored value is confirmed.
    const disagreed = {};
    for (const field of ["title", "authors", "year", "venue", "doi"]) {
      if (changed[field] !== undefined) continue;
      const found = guess[field];
      if (typeof found === "string" && found !== "" && found !== paper[field]) {
        disagreed[field] = { current: paper[field], guess: found };
      }
    }

    // Rebuild the provenance map: fields we just replaced carry their new source,
    // fields we kept keep their existing entry.
    const nextSource = { ...marked };
    for (const field of ["title", "authors", "year", "venue", "doi"]) {
      if (changed[field] === undefined) continue;
      const source = guess.sources?.[field];
      if (typeof source === "string" && source !== "") nextSource[field] = source;
      else delete nextSource[field];
    }
    // A field the extractor disagrees with is a guess again, whatever the old
    // row claimed: mark it so the UI can flag it rather than hiding the conflict.
    for (const field of Object.keys(disagreed)) {
      if (nextSource[field] === undefined || nextSource[field] === "") nextSource[field] = guess.sources?.[field] ?? "page-text";
    }

    const updated = store.updatePaper(paperId, {
      ...next,
      // `verified: false` keeps this write from stamping the row as user-edited:
      // these are machine guesses. Fields the user really did edit were excluded
      // by `replaceable`, and `updatePaper` leaves their provenance untouched
      // when `verified` is false, so this cannot launder them.
      verified: false,
    });
    store.setMetadataSource(paperId, JSON.stringify(nextSource));
    // A left-over conflict means the extractor disagrees with a value the guards
    // refused to replace. Clearing the stamp records that this row's metadata is
    // machine-guessed again, so the UI marks it and a later pass may repair it,
    // rather than the value posing as user-confirmed forever.
    if (Object.keys(disagreed).length > 0) {
      store.clearMetadataVerifiedAt(paperId);
    }

    return {
      paper: store.getPaper(paperId),
      changed,
      disagreed,
      // Report the raw guess too, so the UI can offer a value even when the
      // guards refused to apply it (e.g. a low-confidence venue).
      guess,
      library: store.stats(),
      replacedCount: Object.keys(changed).length,
      updated: updated !== null,
    };
  }

  /**
   * Fill missing metadata from Crossref using the paper's own DOI.
   *
   * Why this exists: the extractor (see `pdf-metadata.js`) guesses from the PDF's
   * layout, and a typeset PDF never states "authors: A; B" anywhere — so authors
   * and venue come back empty far more often than titles and years. But most PDFs
   * *do* carry a DOI, and a DOI is an exact identifier: Crossref returns the
   * authoritative record for it.
   *
   * Scope, deliberately:
   *   - Only fills empty fields and fields still marked as guesses. A field the
   *     user typed is never touched — `planEnrichment` relies on `metadataSource`
   *     for that, which `updatePaper` already maintains.
   *   - Network failure is a reported outcome, not an exception. Enrichment is an
   *     improvement; an offline user must still be able to use the library.
   *   - Works on one paper or the whole library, so a fresh import and a bulk
   *     repair take the same path.
   *
   * @param {PaperScope} paperToolScope
   * @param {{paperId?: string, limit?: number, dryRun?: boolean}} input
   */
  async enrichMetadata(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const dryRun = input?.dryRun === true;

    let targets;
    if (typeof input?.paperId === "string" && input.paperId !== "") {
      const paper = store.getPaper(input.paperId);
      if (paper === null) throw new RemoteError("paper-tool/paper-not-found", "no such paper");
      targets = [paper];
    } else {
      // Whole library: only rows that actually have a DOI are worth a request.
      // A library of 300 papers is 300 sequential Crossref calls, so the cap and
      // the explicit limit keep a single tool call bounded.
      const limit = clampInt(input?.limit, 20, 1, 100);
      targets = store
        .listPapers({ limit: 5000, offset: 0 })
        .filter((paper) => String(paper.doi ?? "").trim() !== "")
        .slice(0, limit);
    }

    if (dryRun) {
      // Reports what it *would* do without writing, so the UI can show a preview
      // and the user can decline. Same lookup path, no mutation.
      const previews = [];
      for (const paper of targets) {
        const found = await lookupDoi(paper.doi, { signal: undefined });
        if (!found.ok) {
          previews.push({ paperId: paper.paperId, doi: paper.doi, ok: false, reason: found.reason });
          continue;
        }
        const plan = planEnrichment(paper, found.record);
        previews.push({
          paperId: paper.paperId,
          doi: paper.doi,
          ok: true,
          wouldChange: plan.changes,
          keptUserFields: plan.kept,
          record: found.record,
        });
      }
      return { dryRun: true, previews, library: store.stats() };
    }

    const { enriched, skipped, failures } = await enrichPapers(store, targets);

    // Stamp provenance so the UI badges a Crossref-filled field differently from a
    // layout-inferred one. Without this the user cannot tell which values were
    // confirmed against an authority and which were guessed off the page.
    for (const entry of enriched) {
      if (!Array.isArray(entry.changed) || entry.changed.length === 0) continue;
      let marked = {};
      try {
        const row = store.getPaper(entry.paperId);
        marked = JSON.parse(row?.metadataSource === "" ? "{}" : (row?.metadataSource ?? "{}"));
      } catch {
        marked = {};
      }
      for (const field of entry.changed) marked[field] = "crossref";
      store.setMetadataSource(entry.paperId, JSON.stringify(marked));
      // A row whose remaining guesses are fewer is still machine-derived; clear the
      // "verified" stamp so the UI keeps marking whatever is left as needing a look.
      store.clearMetadataVerifiedAt(entry.paperId);
    }

    return {
      dryRun: false,
      enriched,
      skipped,
      failures,
      // Convenience for the caller's summary line: how many papers gained at least
      // one authoritative field.
      improved: enriched.filter((entry) => Array.isArray(entry.changed) && entry.changed.length > 0).length,
      library: store.stats(),
    };
  }


  /**
   * List library papers, one page at a time.
   *
   * `offset` existed before but no caller used it, so the client asked for the
   * 500-row ceiling once and could never see paper 501 — not "slow", invisible.
   * The response now reports the total so the caller can tell "this is
   * everything" from "there is another page", instead of guessing from a full
   * page of results.
   */
  async listPapers(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const limit = clampInt(input?.limit, 200, 1, 500);
    const offset = clampInt(input?.offset, 0, 0, 1e6);
    const library = store.stats();
    return {
      papers: store.listPapers({ limit, offset }).map(projectPaperForList),
      library,
      // Cheap to compute next to the query itself, and the client needs it to
      // decide whether to render "load more" at all.
      paging: {
        offset,
        limit_returned: limit,
        total: library.papers,
        hasMore: offset + limit < library.papers,
      },
    };
  }

  /** Full-text search over indexed pages plus metadata fallback. */
  async search(paperToolScope, input) {
    assertScope(paperToolScope);
    const query = typeof input?.query === "string" ? input.query : "";
    if (query.trim() === "") throw new RemoteError("paper-tool/empty-query", "search needs a query");
    const store = this.storeFor(paperToolScope);
    const limit = clampInt(input?.limit, 30, 1, 200);
    const hits = store.search(query, { limit });
    // Metadata fallback keeps abstract-only papers discoverable while being
    // labelled as such, never silently mixed with full-text hits.
    const seen = new Set(hits.map((hit) => hit.paperId));
    const meta = store
      .searchMetadata(query, { limit })
      .filter((paper) => !seen.has(paper.paperId))
      .map((paper) => ({
        paperId: paper.paperId,
        pageIndex: null,
        snippet: paper.abstract ? paper.abstract.slice(0, 160) : paper.title,
        title: paper.title,
        year: paper.year,
        material: paper.material,
        metadataOnly: true,
      }));
    return { query, hits: [...hits, ...meta], library: store.stats() };
  }

  /** Read one paper's page text for the reader / agent. */
  async readPaper(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paper = store.getPaper(requiredString(input?.paperId, "paperId"));
    if (paper === null) throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    const from = clampInt(input?.fromPage, 0, 0, 1e6);
    // Default to a 3-page window: one page is rarely enough to answer from,
    // and callers who want exactly one page pass toPage explicitly.
    const to = clampInt(input?.toPage, from + 3, from, 1e6);
    const pages = [];
    for (let index = from; index < Math.min(to, paper.numPages); index += 1) {
      pages.push({ pageIndex: index, text: store.getPageText(paper.paperId, index) ?? "" });
    }
    return {
      paper,
      pages,
      coverage: {
        numPages: paper.numPages,
        requested: [from, to],
        returned: pages.length,
        material: paper.material,
      },
    };
  }

  /**
   * Build a structured context packet for one question about one paper.
   *
   * This exists because the plugin has no model channel (D-014): the plugin supplies
   * grounded material, and the answer is produced by the Agent in the conversation
   * using whichever model the user selected there. The whole point is that the anchor
   * fields are computed here, from the stored page text, rather than being composed
   * into a human-readable string by the client — a client-built "【页码】第 3 页" line
   * detaches from the actual text the moment anyone edits it, and then the answer can
   * no longer be traced back to a page.
   *
   * The returned `quote` is taken from the stored page text, so it is verbatim by
   * construction. Nothing here is a paraphrase.
   */
  async askContext(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    const paper = store.getPaper(paperId);
    if (paper === null) throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    const question = String(input?.question ?? "").trim();
    if (question === "") throw new RemoteError("paper-tool/empty-question", "question is empty");

    const selectionText = String(input?.selectionText ?? "").trim();
    // The page is always located from the passage when one is given. A caller-supplied
    // pageIndex is a hint only, used when there is no selection to locate — because the
    // sidebar's current page is not evidence of where the passage lives, and accepting
    // it would let a UI showing page 9 attach every question to page 9.
    let pageIndex = -1;
    if (selectionText !== "") {
      // Compare on whitespace-stripped text: a text layer produces soft line breaks
      // that a browser selection preserves, so a verbatim `indexOf` on the raw strings
      // fails for the most common case (a passage spanning two rendered lines).
      const needle = selectionText.replace(/\s+/g, "").slice(0, 160);
      for (let index = 0; index < paper.numPages; index += 1) {
        const text = (store.getPageText(paperId, index) ?? "").replace(/\s+/g, "");
        if (needle !== "" && text.includes(needle)) {
          pageIndex = index;
          break;
        }
      }
    }
    if (pageIndex < 0) {
      // No selection, or nothing matched: fall back to the caller's hint, then page 0.
      pageIndex = clampInt(input?.pageIndex, 0, 0, 1e6);
    }
    const pageText = store.getPageText(paperId, pageIndex) ?? "";

    // Anchor the selection within the page. A selection that cannot be located is
    // reported as unanchored (charStart/charEnd = -1) instead of being given a
    // plausible-looking offset: a wrong anchor is worse than an absent one, because it
    // silently attributes a claim to the wrong passage.
    let charStart = -1;
    let charEnd = -1;
    if (selectionText !== "") {
      const at = pageText.indexOf(selectionText);
      if (at >= 0) {
        charStart = at;
        charEnd = at + selectionText.length;
      }
    }

    // A window around the anchor so the model has surrounding context, not just the
    // selected sentence. Bounded, because this ends up in a prompt.
    const WINDOW = 1200;
    const ctxFrom = charStart >= 0 ? Math.max(0, charStart - WINDOW) : 0;
    const ctxTo = charStart >= 0
      ? Math.min(pageText.length, charEnd + WINDOW)
      : Math.min(pageText.length, WINDOW * 2);

    return {
      paperId,
      title: paper.title,
      question,
      selection: {
        text: selectionText,
        pageIndex,
        charStart,
        charEnd,
        anchored: charStart >= 0,
      },
      context: {
        pageIndex,
        from: ctxFrom,
        to: ctxTo,
        text: pageText.slice(ctxFrom, ctxTo),
      },
      // Say plainly what the caller is looking at, so an unanchored selection cannot be
      // mistaken for a located one downstream.
      coverage: {
        numPages: paper.numPages,
        material: paper.material,
        textSource: paper.textSource,
      },
    };
  }

  /**
   * Store an answer back into the library as evidence or a note, keeping the anchor.
   *
   * The reason this is a separate call rather than part of askContext: the answer does
   * not exist when the context is built. It is produced in the conversation, and only
   * the user decides whether it is worth keeping — so the write is a deliberate second
   * action, not a side effect of asking.
   */
  async saveAnswer(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    const answer = String(input?.answer ?? "").trim();
    if (answer === "") throw new RemoteError("paper-tool/empty-answer", "answer is empty");
    if (store.getPaper(paperId) === null) {
      throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    }
    const pageIndex = clampInt(input?.pageIndex, 0, 0, 1e6);
    const kind = input?.kind === "note" ? "note" : "evidence";
    const question = String(input?.question ?? "").trim();
    const sourceQuote = String(input?.sourceQuote ?? "").trim();
    // Derive the annotation id from the same anchor rule saveAnnotation uses, so asking
    // about the same passage twice updates one note instead of stacking duplicates.
    const anchorId = (quote) =>
      `ann-${createHash("sha256")
        .update(`${paperId}\u0000${pageIndex}\u0000${clampInt(input?.charStart, -1, -1, 1e9)}\u0000${clampInt(input?.charEnd, -1, -1, 1e9)}\u0000${quote}`)
        .digest("hex")
        .slice(0, 32)}`;

    if (kind === "note") {
      const saved = store.upsertAnnotation({
        annotationId: anchorId(sourceQuote),
        paperId,
        pageIndex,
        charStart: clampInt(input?.charStart, -1, -1, 1e9),
        charEnd: clampInt(input?.charEnd, -1, -1, 1e9),
        quote: sourceQuote,
        note: question === "" ? answer : `${question}\n\n${answer}`,
        tags: ["追问"],
        color: "blue",
      });
      return { kind: "note", annotationId: saved.annotationId, pageIndex };
    }

    // Evidence requires a real quote from the paper; an answer is the user's words, not
    // the paper's, unless a source quote is supplied. Refusing here keeps the evidence
    // table meaning "this supports a claim" rather than "something was written here".
    if (sourceQuote === "") {
      throw new RemoteError(
        "paper-tool/answer-has-no-quote",
        "saving an answer as evidence needs the source quote it is based on; use kind=note otherwise",
      );
    }
    // The evidence row carries the paper's words only (its table has no field for
    // anything else). The answer — which is the user's/model's words — goes into an
    // annotation's note on the same anchor, so the two are never conflated in storage
    // even though the UI presents them together.
    const evidence = await this.addEvidence(paperToolScope, {
      paperId,
      pageIndex,
      quote: sourceQuote,
      charStart: clampInt(input?.charStart, -1, -1, 1e9),
      charEnd: clampInt(input?.charEnd, -1, -1, 1e9),
    });
    const noteRow = store.upsertAnnotation({
      annotationId: anchorId(sourceQuote),
      paperId,
      pageIndex,
      charStart: clampInt(input?.charStart, -1, -1, 1e9),
      charEnd: clampInt(input?.charEnd, -1, -1, 1e9),
      quote: sourceQuote,
      note: question === "" ? answer : `${question}\n\n${answer}`,
      tags: ["追问"],
      color: "blue",
    });
    return {
      kind: "evidence",
      evidenceId: evidence.evidenceId,
      annotationId: noteRow.annotationId,
      pageIndex,
    };
  }

  /** Fetch the pdfjs runtime for the sidebar reader (own package files only). */
  async getPdfRuntime(paperToolScope, signal) {
    assertScope(paperToolScope);
    return await readPdfjsRuntime(signal);
  }

  /** Bounded read of an imported PDF's bytes, by paper id (no client paths). */
  async readPaperBytes(paperToolScope, input, signal) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paper = store.getPaper(requiredString(input?.paperId, "paperId"));
    if (paper === null) throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    if (paper.pdfPath === "") {
      throw new RemoteError("paper-tool/no-source-file", "this paper has no stored PDF file");
    }
    const buffer = await readFile(paper.pdfPath);
    signal?.throwIfAborted();
    return { data: new Uint8Array(buffer), bytes: buffer.byteLength, filename: basename(paper.pdfPath) };
  }

  /** Remove a paper and everything derived from it, including its stored PDF. */
  async deletePaper(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    const paper = store.getPaper(paperId);
    if (paper === null) {
      throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    }
    store.deletePaper(paperId);
    if (typeof paper.pdfPath === "string" && paper.pdfPath !== "") {
      // Best-effort: a missing file must not fail the delete.
      await unlink(paper.pdfPath).catch(() => {});
    }
    return { deleted: paperId, library: store.stats() };
  }

  /**
   * Store a text selection as an evidence row. The quote is the authority;
   * the page index keeps later navigation honest about where it came from.
   */
  async addEvidence(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    const quote = requiredString(input?.quote, "quote").trim();
    if (quote === "") throw new RemoteError("paper-tool/empty-quote", "quote is empty");
    // A client could otherwise store an entire book chapter as one "quote",
    // which would then be rendered into every citation and prompt.
    if (quote.length > MAX_QUOTE_CHARS) {
      throw new RemoteError(
        "paper-tool/quote-too-long",
        `quote exceeds ${MAX_QUOTE_CHARS} characters`,
        { length: quote.length, limit: MAX_QUOTE_CHARS },
      );
    }
    if (store.getPaper(paperId) === null) {
      throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    }
    const pageIndex = clampInt(input?.pageIndex, 0, 0, 1e6);
    const evidenceId = randomUUID();
    // Locate the quote inside the page so the anchor is a real character
    // range, not just a page number. A browser selection can carry soft line
    // breaks from the text layer, so a whitespace-normalized second pass is
    // needed; the offsets are mapped back to the original page text.
    const pageText = store.getPageText(paperId, pageIndex) ?? "";
    const anchor = locateQuote(pageText, quote);
    const evidence = store.addEvidence({
      evidenceId,
      paperId,
      pageIndex,
      // -1 is the "not located" sentinel. 0 would be indistinguishable from a
      // quote that genuinely starts at the first character, and the reader
      // would then offer a click-through to an anchor that means nothing.
      charStart: anchor === null ? -1 : anchor.start,
      charEnd: anchor === null ? -1 : anchor.end,
      quote,
    });
    return { evidenceId: evidence.evidenceId, evidence, anchored: anchor !== null };
  }

  /** Remove one evidence row; the paper and its PDF stay untouched. */
  async deleteEvidence(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const evidenceId = requiredString(input?.evidenceId, "evidenceId");
    const existing = store.getEvidence(evidenceId);
    if (existing === null) {
      throw new RemoteError("paper-tool/evidence-not-found", "no such evidence row");
    }
    store.deleteEvidence(evidenceId);
    return { deleted: evidenceId, library: store.stats() };
  }

  /**
   * Record the review's claims and bind each one to evidence that already exists.
   *
   * This is the missing producer for the `claims` / `claim_evidence` tables. They
   * existed from schema v5 but nothing ever wrote them, so the tool's headline
   * feature — claim-level attribution — was never actually produced. Exports
   * carried evidence anchors but no "this sentence rests on these quotes" link.
   *
   * The caller is a model writing prose, so the one risk that matters is invented
   * citations: a plausible-looking evidenceId that resolves to nothing. That is
   * rejected outright rather than stored, because a dangling anchor is exactly the
   * "never invent citations" promise being broken, and it would only surface later
   * as a broken link in a document the user already trusts.
   *
   * @param {PaperScope} paperToolScope
   * @param {{claims: Array<{claimId?: string, text: string, section?: string,
   *          evidenceIds?: string[], evidence?: Array<{evidenceId: string,
   *          stance?: string, strength?: string}>}>}} input
   */
  // --- reader annotations -------------------------------------------------
  //
  // RPC rather than a seventh tool: the tool surface is deliberately frozen at six
  // (see DECISIONS D-013), and marking up a PDF is a UI gesture, not something the
  // model should decide to do mid-conversation. The agent can still read them back
  // through paper_status, which now reports the count.

  /**
   * Create or update one annotation.
   *
   * Anchoring is `pageIndex + charStart/charEnd`, the same content coordinates
   * `evidence` uses. Rectangles were rejected: they go stale on zoom, on device
   * pixel ratio changes and on PDF.js upgrades, while a character offset stays
   * valid as long as the page text does.
   *
   * @param {PaperScope} paperToolScope
   * @param {{annotationId?: string, paperId: string, pageIndex?: number,
   *          charStart?: number, charEnd?: number, quote?: string, note?: string,
   *          tags?: string[]|string, color?: string}} input
   */
  async saveAnnotation(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    if (store.getPaper(paperId) === null) {
      throw new RemoteError("paper-tool/unknown-paper", `no paper with id ${paperId} in this library`);
    }
    const quote = typeof input?.quote === "string" ? input.quote : "";
    const note = typeof input?.note === "string" ? input.note : "";
    // An annotation with neither selected text nor a note would be an invisible
    // row: it occupies a page position but says nothing and cannot be found by
    // reading. Reject it rather than store an empty highlight.
    if (quote.trim() === "" && note.trim() === "") {
      throw new RemoteError("paper-tool/empty-annotation", "an annotation needs either the selected text or a note");
    }
    const pageIndex = Number.isInteger(input?.pageIndex) ? input.pageIndex : 0;
    if (pageIndex < 0) {
      throw new RemoteError("paper-tool/bad-anchor", "pageIndex must be >= 0");
    }
    // Accept an explicit id so the client can update the annotation it just created;
    // otherwise derive one from the anchor so the same selection highlighted twice
    // updates instead of piling up duplicates.
    const annotationId =
      typeof input?.annotationId === "string" && input.annotationId !== ""
        ? input.annotationId
        : `ann-${createHash("sha256")
            .update(`${paperId}\u0000${pageIndex}\u0000${input?.charStart ?? -1}\u0000${input?.charEnd ?? -1}\u0000${quote}`)
            .digest("hex")
            .slice(0, 32)}`;
    const saved = store.upsertAnnotation({
      annotationId,
      paperId,
      pageIndex,
      charStart: Number.isInteger(input?.charStart) ? input.charStart : -1,
      charEnd: Number.isInteger(input?.charEnd) ? input.charEnd : -1,
      quote,
      note,
      tags: input?.tags,
      color: typeof input?.color === "string" && input.color !== "" ? input.color : "yellow",
    });
    return { ok: true, annotation: saved, total: store.countAnnotations({ paperId }) };
  }

  /**
   * Annotations for one paper (or the whole library), ordered by page.
   * @param {PaperScope} paperToolScope
   * @param {{paperId?: string, limit?: number}} input
   */
  async listAnnotations(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = typeof input?.paperId === "string" && input.paperId !== "" ? input.paperId : undefined;
    const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, 2000) : 500;
    const annotations = store.listAnnotations({ paperId, limit });
    return { ok: true, annotations, count: annotations.length, total: store.countAnnotations({ paperId }) };
  }

  /**
   * Remove one annotation.
   * @param {PaperScope} paperToolScope
   * @param {{annotationId: string}} input
   */
  async deleteAnnotation(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const annotationId = requiredString(input?.annotationId, "annotationId");
    const existed = store.getAnnotation(annotationId) !== null;
    store.deleteAnnotation(annotationId);
    // Report whether it was actually there: a delete that silently succeeds on a
    // typo'd id hides a client bug, and the caller cannot tell "removed" from
    // "never existed".
    return { ok: true, removed: existed, total: store.countAnnotations() };
  }

  /**
   * Promote an annotation to evidence.
   *
   * One direction only (annotation -> evidence), never the reverse, and it copies the
   * anchor rather than moving it: the annotation stays where the reader left it. The
   * two tables stay separate afterwards — see the DDL comment for why merging them
   * would corrupt every "how much evidence" figure.
   *
   * @param {PaperScope} paperToolScope
   * @param {{annotationId: string}} input
   */
  async promoteAnnotation(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const annotationId = requiredString(input?.annotationId, "annotationId");
    const annotation = store.getAnnotation(annotationId);
    if (annotation === null) {
      throw new RemoteError("paper-tool/unknown-annotation", `no annotation with id ${annotationId}`);
    }
    if (annotation.quote.trim() === "") {
      // Evidence is a quotation; a note-only annotation has nothing to quote, and
      // fabricating the text from the note would invent a source passage.
      throw new RemoteError(
        "paper-tool/annotation-has-no-quote",
        "this annotation has no selected text, so there is nothing to quote as evidence",
      );
    }
    const evidence = store.addEvidence({
      evidenceId: `ev-${createHash("sha256").update(`${annotationId}\u0000${annotation.quote}`).digest("hex").slice(0, 32)}`,
      paperId: annotation.paperId,
      pageIndex: annotation.pageIndex,
      charStart: annotation.charStart,
      charEnd: annotation.charEnd,
      quote: annotation.quote,
    });
    return { ok: true, evidence, annotation };
  }

  async recordClaims(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const incoming = Array.isArray(input?.claims) ? input.claims : [];
    if (incoming.length === 0) {
      throw new RemoteError("paper-tool/empty-claims", "no claims were supplied");
    }

    const accepted = [];
    const rejected = [];
    const unsupported = [];
    for (const raw of incoming) {
      const text = typeof raw?.text === "string" ? raw.text.trim() : "";
      if (text === "") {
        rejected.push({ text: "", reason: "empty claim text" });
        continue;
      }
      // Accept either shape: a bare id list or full link objects. Models produce
      // both, and forcing one would make the tool fail for a cosmetic difference.
      const links = Array.isArray(raw?.evidence)
        ? raw.evidence
        : (Array.isArray(raw?.evidenceIds) ? raw.evidenceIds.map((id) => ({ evidenceId: id })) : []);
      const section = (typeof raw?.section === "string" ? raw.section.trim() : "").slice(0, 200) || "正文";

      // Identity: an explicit claimId wins; otherwise derive one from the sentence
      // itself. Exporting the same draft twice must not grow the table with
      // duplicates — "re-running the export is idempotent" is an acceptance
      // criterion, and a random id made every pass add a row. The text is the
      // natural key because a review sentence *is* its text.
      const claimId = typeof raw?.claimId === "string" && raw.claimId.trim() !== ""
        ? raw.claimId.trim()
        : `claim-${createHash("sha256").update(`${section}\u0000${text}`).digest("hex").slice(0, 32)}`;

      // A claim with no evidence is a real, reportable state: stored and flagged so
      // the user can see which sentences still need a source. It is reported once,
      // through `unsupported`, not also counted as a rejection — the two mean
      // different things and double-counting made the summary line nonsensical.
      if (links.length === 0) unsupported.push({ claimId, text });
      try {
        const written = store.upsertClaim({
          claimId,
          text: text.slice(0, MAX_CLAIM_CHARS),
          section,
          evidence: links.map((link) => ({
            evidenceId: String(link?.evidenceId ?? ""),
            stance: STANCES.includes(link?.stance) ? link.stance : "support",
            strength: ["high", "medium", "low"].includes(link?.strength) ? link.strength : "medium",
          })),
        });
        accepted.push({ claimId, text: written.claim.text, evidenceCount: written.links.length });
      } catch (error) {
        // Only the "unknown evidence" refusal is a per-claim outcome worth
        // reporting. Anything else is a real fault and must not be swallowed.
        if (error?.code !== "paper-tool/unknown-evidence") throw error;
        rejected.push({ claimId, text, reason: error.message, missing: error.missing ?? [] });
      }
    }

    return {
      accepted,
      rejected,
      // Claims that were accepted but carry no evidence, kept separate from
      // `rejected` because nothing about them failed — they are simply unsourced.
      unsupported: unsupported.length > 0 ? unsupported : store.unsupportedClaims({ limit: 200 }).map((c) => ({ claimId: c.claimId, text: c.text })),
      // Report the library counters so the caller can verify the write actually
      // landed instead of trusting its own bookkeeping.
      library: store.stats(),
    };
  }

  /** Claims with their evidence, in review order. */
  async listClaims(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const claims = store.listClaims({ section: input?.section, limit: clampInt(input?.limit, 500, 1, 5000) });
    const unsupported = store.unsupportedClaims({ limit: 1000 });
    return {
      claims,
      unsupported,
      library: store.stats(),
      // A one-line roll-up for the tool's text render: how much of the draft is
      // actually attributable.
      summary: {
        total: claims.length,
        supported: claims.filter((c) => Array.isArray(c.evidence) && c.evidence.length > 0).length,
        unsupported: unsupported.length,
      },
    };
  }

  /**
   * Export a traceable review bundle: Markdown + BibTeX.
   *
   * The Markdown contains evidence with page anchors and a bibliography. It
   * deliberately contains no generated prose: the model writes the prose in
   * chat from exactly this material, so every sentence can be traced back.
   */
  async exportReview(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const styleId = typeof input?.style === "string" && input.style !== "" ? input.style : "apa";
    const locale = typeof input?.locale === "string" && input.locale !== "" ? input.locale : "en-US";
    const title = typeof input?.title === "string" && input.title.trim() !== "" ? input.title.trim() : "文献综述材料";

    const requested = Array.isArray(input?.evidenceIds) ? new Set(input.evidenceIds) : null;
    // Filter in SQL so "all anchored evidence" means the whole library, not
    // whatever page of it the client happened to have loaded.
    const anchor = input?.anchor === "anchored" ? "anchored" : "all";
    const evidence = store
      .listEvidence({ limit: 5000, anchor })
      .filter((row) => requested === null || requested.has(row.evidenceId));
    if (evidence.length === 0) {
      return { ok: false, reason: "还没有证据条目；先在阅读器里存证据或按主题收集。", warnings: [] };
    }
    const evidenceIds = evidence.map((row) => row.evidenceId);
    const papers = store.papersForEvidence({ evidenceIds });
    if (papers.length === 0) {
      return { ok: false, reason: "证据没有关联到任何库内论文。", warnings: [] };
    }

    const warnings = [];
    for (const paper of papers) {
      if (!String(paper.title ?? "").trim()) warnings.push(`${paper.paperId}：缺少标题`);
      if (!String(paper.authors ?? "").trim()) warnings.push(`${paper.title || paper.paperId}：缺少作者`);
      if (!/^\d{4}$/.test(String(paper.year ?? "").trim())) {
        warnings.push(`${paper.title || paper.paperId}：年份不完整（${paper.year || "空"}）`);
      }
    }

    const rendered = await renderBibliography(papers, styleId, locale);
    if (!rendered.ok) {
      return { ok: false, reason: rendered.reason ?? `无法渲染 ${styleId}`, warnings };
    }
    warnings.push(...(rendered.warnings ?? []));
    const bib = renderBibtex(papers);

    const byPaper = new Map();
    for (const row of evidence) {
      if (!byPaper.has(row.paperId)) byPaper.set(row.paperId, []);
      byPaper.get(row.paperId).push(row);
    }
    const evidenceSections = papers.map((paper) => {
      const rows = byPaper.get(paper.paperId) ?? [];
      // Mark the origin on every quote: an exported review is the artefact people
      // paste into a manuscript, so a quote that was guessed by OCR has to be
      // distinguishable from one read out of a text layer after it leaves here.
      const lines = rows.map((row) => {
        const fromOcr = row.paperTextSource === "ocr" || paper.textSource === "ocr";
        const marker = fromOcr ? "（OCR）" : "";
        return `- p.${row.pageIndex + 1} [E:${row.evidenceId.slice(0, 8)}]${marker} “${row.quote}”`;
      });
      const heading = `### ${paper.title || paper.paperId}${paper.year ? ` (${paper.year})` : ""}`;
      return `${heading}\n\n${lines.join("\n")}`;
    });

    const generatedAt = new Date().toISOString();

    // Render the review body when the caller supplied filled slots. Done before the
    // claim layer so a rejected anchor is reported in the same result; the body is
    // what the user reads, the claims are what it rests on.
    let bodySection = null;
    let bodySentenceCount = 0;
    let bodyUnsupported = [];
    let bodyRejected = [];
    if (Array.isArray(input?.sentences) && input.sentences.length > 0) {
      const body = await this.renderBody(paperToolScope, {
        section: typeof input?.bodySection === "string" ? input.bodySection : "综述正文",
        sentences: input.sentences,
      });
      if (body.ok) {
        bodySection = body;
        bodySentenceCount = body.sentences.length;
        bodyUnsupported = body.unsupported;
        bodyRejected = body.rejected ?? [];
      }
    }

    // Persist the draft's claims before rendering, so the export can carry the
    // claim layer and the library remembers it for the next pass. Doing this inside
    // the export is deliberate: the claims and the evidence bundle are one artefact,
    // and asking the model to call a second tool afterwards is a step it skips.
    let claimsSummary = null;
    let claimSections = "";
    let appendix = "";
    if (Array.isArray(input?.claims) && input.claims.length > 0) {
      const recorded = await this.recordClaims(paperToolScope, { claims: input.claims });
      claimsSummary = {
        accepted: recorded.accepted.length,
        rejected: recorded.rejected.length,
        unsupported: recorded.unsupported.length,
        rejectedDetail: recorded.rejected,
      };
      const claims = store.listClaims({ limit: 5000 });
      // Dedupe for rendering only: `upsertClaim` keys claims by their text, so the
      // table cannot hold two rows for one sentence. What *can* duplicate is a
      // caller passing the same claim twice in one payload; that is a no-op write
      // but would otherwise print the sentence twice in the draft.
      const seenClaim = new Set();
      const uniqueClaims = claims.filter((claim) => {
        if (seenClaim.has(claim.claimId)) return false;
        seenClaim.add(claim.claimId);
        return true;
      });
      const quoteOf = new Map();
      for (const row of evidence) quoteOf.set(row.evidenceId, row);

      const renderClaim = (claim) => {
        const tags = claim.evidence
          .map((row) => {
            const paper = papers.find((p) => p.paperId === row.paperId);
            const where = paper === undefined ? row.paperId : (paper.title || row.paperId);
            return `[E:${row.evidenceId.slice(0, 8)}]（${where} p.${row.pageIndex + 1}）`;
          })
          .join(" ");
        return `- ${claim.text}${tags === "" ? " — **⚠ 暂无证据支撑**" : ` — ${tags}`}`;
      };

      const bySection = new Map();
      for (const claim of uniqueClaims) {
        if (!bySection.has(claim.section)) bySection.set(claim.section, []);
        bySection.get(claim.section).push(claim);
      }
      claimSections = [...bySection.entries()]
        // Prefixed because a claim section and the body section are routinely the
        // same name ("研究现状" in both), and two identically-titled headings in one
        // document read as a bug even when the content differs.
        .map(([section, rows]) => `### 论断 · ${section}\n\n${rows.map(renderClaim).join("\n")}`)
        .join("\n\n");

      // Three columns: the sentence, the evidence it rests on, and where that
      // evidence lives. This is the artefact the tool exists to produce — a reader
      // must be able to check any sentence against a page without hunting.
      const appendixRows = ["| 论断 | 证据 | 出处 |", "|---|---|---|"];
      for (const claim of uniqueClaims) {
        if (claim.evidence.length === 0) {
          appendixRows.push(`| ${escapeCell(claim.text)} | ⚠ 无 | — |`);
          continue;
        }
        for (const row of claim.evidence) {
          const paper = papers.find((p) => p.paperId === row.paperId);
          const source = `${paper?.title || row.paperId}${paper?.year ? ` (${paper.year})` : ""} p.${row.pageIndex + 1}`;
          const quote = quoteOf.get(row.evidenceId)?.quote ?? row.quote;
          appendixRows.push(
            `| ${escapeCell(claim.text)} | ${escapeCell(`[E:${row.evidenceId.slice(0, 8)}] ${quote}`)} | ${escapeCell(source)} |`,
          );
        }
      }
      appendix = appendixRows.join("\n");
    }

    // Count how much of this review rests on guessed characters. If any does, the
    // exported file says so at the top and per quote, not only in the UI the user
    // has already scrolled past.
    const ocrPapers = papers.filter((paper) => paper.textSource === "ocr").length;
    const ocrEvidence = evidence.filter((row) => row.paperTextSource === "ocr").length;
    const markdown = [
      `# ${title}`,
      "",
      `- 生成时间：${generatedAt}`,
      `- 引用样式：${rendered.styleId}`,
      `- 证据：${evidence.length} 条 / 论文：${papers.length} 篇`,
      claimsSummary === null
        ? null
        : `- 论断：${claimsSummary.accepted} 条已绑定证据` +
          (claimsSummary.unsupported > 0 ? `，${claimsSummary.unsupported} 条缺证据` : "") +
          (claimsSummary.rejected > 0 ? `，${claimsSummary.rejected} 条被拒绝（引用了不存在的证据）` : ""),
      bodySentenceCount === 0
        ? null
        : `- 正文：${bodySentenceCount} 句，全部带 [E:xxxxxxxx] 锚点` +
          (bodyUnsupported.length > 0 ? `；${bodyUnsupported.length} 句待补充证据` : "") +
          (bodyRejected.length > 0 ? `；${bodyRejected.length} 句被拒绝（锚点不匹配槽位）` : ""),
      ocrEvidence > 0
        ? `- OCR 文本：${ocrEvidence} 条证据来自 ${ocrPapers} 篇扫描件（这些引文由 OCR 识别，个别字可能有误，引用前请对照原文）`
        : null,
      warnings.length > 0 ? `- 核验提示：${warnings.length} 项，见文末` : "- 核验提示：无",
      "",
      // The body reads first: it is the review. Everything below it is the apparatus
      // that makes each sentence checkable, which is the right order for a document
      // someone actually reads.
      //
      // The body's heading is intentionally not the same string as a claim section
      // heading: both are user-supplied and commonly both "研究现状", which produced
      // two headings with the same text at different levels — a document that looks
      // like it has a duplicated section. The claim layer is nested under its own
      // "论断与证据" heading, so only the body uses the section name at `##`.
      bodySentenceCount === 0 ? null : `## ${bodySection.section}`,
      bodySentenceCount === 0 ? null : "",
      bodySentenceCount === 0 ? null : bodySection.markdown,
      bodySentenceCount === 0 ? null : "",
      bodyUnsupported.length === 0 ? null : "### 待补充证据",
      bodyUnsupported.length === 0 ? null : "",
      bodyUnsupported.length === 0
        ? null
        : bodyUnsupported.map((item) => `- ${item.text}`).join("\n"),
      bodyUnsupported.length === 0 ? null : "",
      claimsSummary === null ? null : "## 论断与证据",
      claimsSummary === null ? null : "",
      claimsSummary === null ? null : claimSections,
      claimsSummary === null ? null : "",
      "## 证据大纲",
      "",
      evidenceSections.join("\n\n"),
      "",
      "## 正文引用",
      "",
      rendered.citation,
      "",
      "## 参考文献",
      "",
      rendered.bibliography,
      "",
      "## 核验",
      "",
      ...(ocrEvidence > 0
        ? [`- ${ocrEvidence} 条证据来自 OCR 文本，标注为（OCR），引用前请核对原文页面。`]
        : []),
      warnings.length === 0 ? "- 所有条目的作者与年份齐全。" : warnings.map((item) => `- ${item}`).join("\n"),
      "",
      appendix === "" ? null : "## 附录：论断 ↔ 证据 ↔ 出处",
      appendix === "" ? null : "",
      appendix === "" ? null : appendix,
      appendix === "" ? null : "",
    ]
      .filter((line) => line !== null)
      .join("\n");

    const stamp = generatedAt.replace(/[:.]/g, "-");
    const dir = join(paperToolScope.workspaceRoot, ".dsh", "paper-tool", "exports", stamp);
    await mkdir(dir, { recursive: true });
    const markdownPath = join(dir, "review.md");
    const bibtexPath = join(dir, "references.bib");
    await writeFile(markdownPath, markdown, "utf8");
    await writeFile(bibtexPath, `${bib.bibtex}\n`, "utf8");

    return {
      ok: true,
      styleId: rendered.styleId,
      locale: rendered.locale ?? locale,
      generatedAt,
      evidenceCount: evidence.length,
      paperCount: papers.length,
      markdown,
      bibtex: bib.bibtex,
      citation: rendered.citation,
      bibliography: rendered.bibliography,
      warnings,
      // Present only when the caller supplied claims, so an evidence-only export
      // does not claim to have a claim layer it never had.
      ...(claimsSummary === null ? {} : { claims: claimsSummary }),
      // Same rule for the body: absent input means absent output, not empty output.
      ...(bodySentenceCount === 0
        ? {}
        : {
            body: {
              section: bodySection.section,
              sentences: bodySentenceCount,
              unsupported: bodyUnsupported,
              rejected: bodyRejected,
            },
          }),
      entries: papers.map((paper) => ({
        paperId: paper.paperId,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        venue: paper.venue,
        doi: paper.doi,
        citekey: bib.keys.find((item) => item.paperId === paper.paperId)?.key ?? "",
      })),
      paths: { dir, markdown: markdownPath, bibtex: bibtexPath },
    };
  }
}

/**
 * Make a string safe to put inside one Markdown table cell.
 *
 * A claim or a quote can contain `|`, which would split the row into extra columns
 * and silently corrupt the appendix; and a newline would end the row. Both are
 * ordinary in academic prose (a table of results pasted into a quote), so escaping
 * is not optional.
 */
function escapeCell(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Is this URL safe to hand to a browser holding the user's CNKI session?
 *
 * Only https on cnki.net (or a subdomain) qualifies. Deliberately strict: the
 * point is to prevent the authenticated tab being steered anywhere else at all,
 * not to allow a broader set of "probably fine" origins.
 */
function isCnkiUrl(href) {
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "cnki.net" || host.endsWith(".cnki.net");
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("unsupported file payload");
}

/**
 * Find a quote in page text, tolerating whitespace differences from a browser
 * text layer. Returns offsets into the original string (not the normalized one).
 *
 * Three channels, cheapest first. The third exists because the first two cannot
 * agree with what the client asked for: `normalizeSelection` in client.js drops
 * the space between two CJK characters, while `normalizeSpaceWithMap` here keeps
 * one. A Chinese PDF breaks lines mid-sentence, so that disagreement is not an
 * edge case — it made every hand-selected quote fail to anchor on 7 of 24 real
 * papers, and unanchored evidence is silently left out of the export. Mirroring
 * the client's rule (and mapping offsets back) closed that gap: 92/144 → 144/144
 * on the same corpus.
 */
function locateQuote(pageText, quote) {
  const text = String(pageText ?? "");
  const needle = String(quote ?? "");
  if (text === "" || needle === "") return null;
  const exact = text.indexOf(needle);
  if (exact >= 0) return { start: exact, end: exact + needle.length };

  const target = normalizeSpace(needle);
  if (target === "") return null;
  const normalized = normalizeSpaceWithMap(text);
  const at = normalized.text.indexOf(target);
  if (at >= 0) {
    const start = normalized.map[at];
    const last = normalized.map[at + target.length - 1];
    return { start, end: last + 1 };
  }

  // Third channel: apply the client's own selection rule to the page text, so
  // the two sides cannot disagree. Only reached when the first two fail.
  const clientTarget = normalizeLikeClient(needle);
  if (clientTarget === "") return null;
  const mirrored = normalizeLikeClientWithMap(text);
  const hit = mirrored.text.indexOf(clientTarget);
  if (hit < 0) return null;
  const start = mirrored.map[hit];
  const last = mirrored.map[hit + clientTarget.length - 1];
  return { start, end: last + 1 };
}

/**
 * The page cap for one OCR run.
 *
 * A named function rather than a inline expression so the rule is testable without
 * running OCR: the arithmetic (which value wins, what a nonsense value falls back to)
 * is the part that has been wrong before, and it does not need a scanned PDF to verify.
 *
 * Order: an explicit per-run cap wins, then the configured value, then the constant.
 * Every candidate goes through clampInt so `maxOcrPages: 0` (which would silently forbid
 * all OCR) or `"abc"` falls back to the default instead of breaking recognition.
 */
export function resolveOcrPageCap(config, pageCap) {
  // `clampInt` alone is not enough: it would map 0 to the lower bound (1), silently
  // turning "unset/nonsense" into "recognise at most one page" — worse than the default.
  // Only a genuine positive number is honoured; anything else falls back to the constant.
  const candidate = pageCap ?? config?.maxOcrPages;
  const numeric = typeof candidate === "number" ? candidate : Number(candidate);
  if (!Number.isFinite(numeric) || numeric < 1) return MAX_OCR_PAGES;
  return clampInt(numeric, MAX_OCR_PAGES, 1, 5000);
}

/**
 * The same rule `client.js:normalizeSelection` applies to a browser selection:
 * collapse whitespace, then join CJK characters that a text layer split apart.
 */
function normalizeLikeClient(value) {
  const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
  return collapsed.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
}

/** `normalizeLikeClient`, keeping a map from each output char back to source. */
function normalizeLikeClientWithMap(value) {
  const source = String(value ?? "");
  const collapsed = [];
  const collapsedMap = [];
  let pendingSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) {
      pendingSpace = collapsed.length > 0;
      continue;
    }
    if (pendingSpace) {
      collapsed.push(" ");
      collapsedMap.push(index);
      pendingSpace = false;
    }
    collapsed.push(char);
    collapsedMap.push(index);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === " ") {
    collapsed.pop();
    collapsedMap.pop();
  }

  // Second pass: drop a single space that sits between two CJK characters.
  const out = [];
  const map = [];
  const isCjk = (char) => char !== undefined && /[\u4e00-\u9fff]/.test(char);
  for (let index = 0; index < collapsed.length; index += 1) {
    const char = collapsed[index];
    if (char === " " && isCjk(out[out.length - 1]) && isCjk(collapsed[index + 1])) continue;
    out.push(char);
    map.push(collapsedMap[index]);
  }
  return { text: out.join(""), map };
}

function normalizeSpace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSpaceWithMap(value) {
  const source = String(value ?? "");
  const out = [];
  const map = [];
  let pendingSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(" ");
      map.push(index);
      pendingSpace = false;
    }
    out.push(char);
    map.push(index);
  }
  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { text: out.join(""), map };
}

function requiredString(value, field) {
  if (typeof value !== "string" || value === "") {
    throw new RemoteError("paper-tool/bad-input", `${field} is required`);
  }
  return value;
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === "number" ? Math.trunc(value) : fallback;
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function assertScope(scope) {
  if (typeof scope !== "object" || scope === null || typeof scope.sessionId !== "string") {
    throw new RemoteError("paper-tool/scope-missing", "session scope did not resolve");
  }
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** One-line error text. Import failures are reported to the user, so the
 *  message must not carry a multi-line stack or the PowerShell transcript. */
function describeUnknown(error) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message.split(/\r?\n/)[0].slice(0, 200);
}

/**
 * Whether an error is a cancellation rather than a failure.
 *
 * This distinction is load-bearing at every place a long job can be interrupted: a
 * cancellation reported as "OCR failed" tells the user their PDF is broken when they
 * are the one who pressed stop. Both shapes are recognised because `throwIfAborted()`
 * produces a DOMException named AbortError while a hand-rolled check often throws a
 * plain Error with code ABORT_ERR.
 */
function isAbortError(error) {
  if (error === null || typeof error !== "object") return false;
  return error.name === "AbortError" || error.code === "ABORT_ERR";
}

/** Split text into comparable terms; CJK gets bigrams since it has no spaces. */
function terms(text) {
  const value = String(text ?? "").toLowerCase();
  const words = value.match(/[a-z0-9]{2,}/g) ?? [];
  const cjkRuns = value.match(/[\u4e00-\u9fff]+/g) ?? [];
  const bigrams = [];
  for (const run of cjkRuns) {
    if (run.length === 1) bigrams.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) {
      bigrams.push(run.slice(index, index + 2));
    }
  }
  return [...new Set([...words, ...bigrams])];
}

/**
 * Find the sentence around the first query-term occurrence.
 *
 * Returns a complete-looking passage rather than a fixed-width window, because
 * a quote cut mid-phrase is not citable.
 *
 * The returned offsets always describe exactly the returned quote: trimming and
 * the length cap both move the boundaries, so they are recomputed against the
 * final slice. An anchor that pointed at a wider range would let a later
 * click-through highlight text the quote never covered.
 */
function pickQuote(pageText, query) {
  const text = String(pageText ?? "");
  if (text === "") return null;
  const queryTerms = terms(query);
  let at = -1;
  for (const term of queryTerms) {
    at = text.toLowerCase().indexOf(term);
    if (at >= 0) break;
  }
  if (at < 0) return null;
  // Expand to sentence boundaries, bounded so one hit cannot swallow the page.
  const before = text.slice(Math.max(0, at - 240), at);
  const after = text.slice(at, Math.min(text.length, at + 400));
  const startCut = Math.max(before.lastIndexOf("。"), before.lastIndexOf(". "), before.lastIndexOf("！"), before.lastIndexOf("？"));
  let start = Math.max(0, at - 240) + (startCut >= 0 ? startCut + 1 : 0);
  const endMatch = /[。！？]|\.\s/.exec(after.slice(Math.max(0, at - start) + 1));
  let end = endMatch === null ? Math.min(text.length, at + 400) : at + Math.max(0, at - start) + 1 + endMatch.index + endMatch[0].length;
  end = Math.min(text.length, end);

  let raw = text.slice(start, end);
  if (raw.trim().length < 12) return null;

  // Recompute the boundaries so they describe the trimmed, capped quote.
  const leading = raw.length - raw.trimStart().length;
  start += leading;
  raw = raw.trimStart();
  if (raw.length > MAX_QUOTE_CHARS) {
    // The ellipsis is a display marker, not source text: the offsets must end
    // where the source passage ends, or a click-through would highlight one
    // character that is not part of the page.
    raw = raw.slice(0, MAX_QUOTE_CHARS);
    end = start + raw.length;
    return { start, end, quote: `${raw}…`, truncated: true };
  }
  raw = raw.trimEnd();
  end = start + raw.length;
  return { start, end, quote: raw, truncated: false };
}

/** Cap for a stored quote; long enough to be citable, short enough to read. */
const MAX_QUOTE_CHARS = 500;

/**
 * Cap for a claim's text.
 *
 * A claim is one sentence of a review — the thing a single citation supports. The
 * limit is generous enough for a long academic sentence in either language and
 * still short enough that a whole paragraph pasted in gets rejected rather than
 * silently truncated into something it never said.
 */
const MAX_CLAIM_CHARS = 2000;

const STANCES = ["support", "conflict", "not_found", "no_evidence"];

for (const method of [
  "status",
  "importPdf",
  "updatePaper",
  "listPapers",
  "search",
  "readPaper",
  "getPdfRuntime",
  "getPdfAsset",
  "readPaperBytes",
  "deletePaper",
  "addEvidence",
  "deleteEvidence",
  "collectEvidence",
  "listEvidence",
  "reviewOutline",
  "reviewMatrix",
  "formatCitations",
  "exportReview",
  "searchExternal",
  "addCandidates",
  "ocrPaper",
  "reextractMetadata",
  "enrichMetadata",
  "cnkiStatus",
  "cnkiConnect",
  "cnkiDisconnect",
  "cnkiSearch",
  "cnkiDownload",
  "recordClaims",
  "listClaims",
  "reviewBodyPlan",
  "renderBody",
  // Reader annotations. RPCs rather than a seventh tool: the tool surface is frozen
  // at six (D-013), and highlighting a PDF is a UI gesture rather than something the
  // model decides to do mid-conversation. The agent reads the result back through
  // paper_status, which now reports the annotation count.
  "saveAnnotation",
  "listAnnotations",
  "deleteAnnotation",
  "promoteAnnotation",
  "askContext",
  "saveAnswer",
  // Watch folder. Opt-in, single folder, no background scanning by default.
  "watchStart",
  "watchStop",
  "watchStatus",
  // Translation. RPCs, not a seventh tool: the tool surface is frozen at six
  // (README hard rule 4), and the plugin holds no model channel (D-014). What it
  // does is prepare segments with anchors and store what comes back.
  "translateSegments",
  "saveTranslation",
  "listTranslations",
  "deleteTranslation",
]) {
  markRemote(PaperToolService, method);
}

export { SERVICE_KEY, LOOKUP };

/**
 * Exported for the anchoring gate only.
 *
 * Quote location is the one piece of logic the client and the host must agree
 * on; when they disagreed, hand-selected quotes silently failed to anchor on
 * every Chinese paper tested and were then dropped from the export. A gate needs
 * to call this directly with adversarial whitespace.
 */
export { locateQuote };


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
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { openStore, defaultDbPath, sharedDbPath, adoptLegacyLibrary } from "./store.js";
import { extractPdfPages, guessMetadata } from "./pdf-extract.js";
import { rasterizePdfPages } from "./pdf-raster.js";
import { ocrAvailable, ocrPages } from "./ocr.js";
import { readPdfjsRuntime, readPdfjsAsset } from "./gui-assets.js";
import { availableStyles, renderBibliography, normalizeLocale } from "./citeproc.js";
import { renderBibtex } from "./bibtex.js";
import { searchExternal as searchExternalQuery, importCandidates } from "./external-search.js";
import {
  connect as cnkiConnect,
  disconnect as cnkiDisconnect,
  status as cnkiStatus,
  search as cnkiSearch,
  downloadPdf as cnkiDownloadPdf,
} from "./cnki.js";
import { markRemote } from "./remote-mark.js";

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

export class PaperToolService extends TypertRemoteService {
  static inject = ["sessions", "typert"];

  constructor(ctx, config = {}) {
    super(ctx, SERVICE_KEY);
    this.config = config;
    /** @type {Map<string, import("node:sqlite").DatabaseSync>} */
    this.stores = new Map();
    this.ctx = ctx;

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
  async #runOcr(bytes, extracted) {
    this.ocrSkipReason = "";
    if (extracted.numPages > MAX_OCR_PAGES) {
      this.ocrSkipReason = `the PDF has ${extracted.numPages} pages, more than the ${MAX_OCR_PAGES}-page OCR cap`;
      return null;
    }
    const status = await ocrAvailable();
    if (!status.available) {
      this.ocrSkipReason = status.reason;
      return null;
    }
    let raster;
    try {
      raster = await rasterizePdfPages(bytes);
    } catch (error) {
      this.ocrSkipReason = `page rendering failed: ${describeUnknown(error)}`;
      return null;
    }
    if (raster.pages.length === 0) {
      this.ocrSkipReason = "no page could be rendered";
      return null;
    }
    let texts;
    try {
      texts = await ocrPages(
        raster.pages.map((page) => page.png),
        { language: status.language },
      );
    } catch (error) {
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
   * OCR a paper that was imported before OCR existed, or whose earlier
   * recognition failed. Idempotent: it replaces page text rather than appending.
   */
  async ocrPaper(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const paperId = requiredString(input?.paperId, "paperId");
    const paper = store.getPaper(paperId);
    if (paper === null) throw new RemoteError("paper-tool/paper-not-found", "no such paper");
    if (typeof paper.pdfPath !== "string" || paper.pdfPath === "") {
      throw new RemoteError("paper-tool/no-pdf", "this paper has no stored PDF to OCR");
    }
    const bytes = new Uint8Array(await readFile(paper.pdfPath));
    const extracted = await extractPdfPages(bytes);
    const existingText = extracted.pages.filter((page) => page.trim() !== "").length;
    if (existingText > 0) {
      return {
        paperId,
        skipped: true,
        reason: "this PDF already has a text layer; OCR would replace correct text with guesses",
      };
    }
    const ocr = await this.#runOcr(bytes, extracted);
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
    return {
      paperId,
      material: updated.material,
      textSource: updated.textSource,
      pagesRecognised: ocr.pagesRecognised,
      pagesFailed: ocr.pagesFailed,
      language: ocr.language,
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

  /** List stored evidence, optionally for one paper. */
  async listEvidence(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const limit = clampInt(input?.limit, 200, 1, 2000);
    return { evidence: store.listEvidence({ paperId: input?.paperId, limit }) };
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
    const rows = [];
    const papers = store.listPapers({ limit: 2000 });
    const evidenceRows = scopeIds === null
      ? store.listEvidence({ limit: 2000 })
      : store.evidenceByIds([...scopeIds], { limit: 2000 });
    const byPaper = new Map();
    for (const row of evidenceRows) {
      if (!byPaper.has(row.paperId)) byPaper.set(row.paperId, []);
      byPaper.get(row.paperId).push(row);
    }
    /** Hoisted: terms(claim) does not change across the per-paper loop. */
    const claimTerms = claim === "" ? [] : terms(claim);

    // With no claim there is nothing to judge, so the matrix degrades to a
    // coverage table: "does this paper have evidence at all". Reporting
    // support/not_found here would be a stance judgement nobody asked for.
    const coverageOnly = claim === "";
    for (const paper of papers) {
      const items = byPaper.get(paper.paperId) ?? [];
      const support = [];
      const conflict = [];
      const notFound = [];
      if (coverageOnly) {
        for (const item of items) support.push(item);
      } else {
        for (const item of items) {
          const quoteTerms = new Set(terms(item.quote));
          const overlap = claimTerms.filter((term) => quoteTerms.has(term));
          // Overlap is a routing signal, not an entailment judgement. The model
          // does the reading; this only decides what to show it and flags
          // negation so a contradicting passage is not silently counted as
          // support.
          if (overlap.length === 0) {
            notFound.push(item);
          } else if (NEGATIONS.some((negation) => item.quote.includes(negation))) {
            conflict.push(item);
          } else {
            support.push(item);
          }
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
      rows.push({
        paperId: paper.paperId,
        title: paper.title || paper.paperId,
        year: paper.year,
        stance,
        evidenceIds: [...support, ...conflict].map((item) => item.evidenceId),
        // Without this the "not mentioned" rows show a count but offer no way
        // back to the passages that produced it.
        notFoundEvidenceIds: notFound.map((item) => item.evidenceId),
        supportCount: support.length,
        conflictCount: conflict.length,
        notFoundCount: notFound.length,
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
    const lines = rows.map(
      (row) =>
        `- ${label(row.stance)} · ${row.title}${row.year ? ` (${row.year})` : ""} — ${row.supportCount + row.conflictCount} 条证据`,
    );
    const summary = coverageOnly
      ? `有证据 ${counts.covered} 篇 · 无证据 ${counts.empty} 篇`
      : `支持 ${counts.support} 篇 · 冲突 ${counts.conflict} 篇 · 未提及 ${counts.not_found} 篇`;
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
    const papers = store.papersForEvidence({ evidenceIds: input?.evidenceIds });
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
    if (files.length > MAX_IMPORT_FILES) {
      throw new RemoteError(
        "paper-tool/too-many-files",
        `importPdf accepts at most ${MAX_IMPORT_FILES} files per call`,
        { count: files.length, limit: MAX_IMPORT_FILES },
      );
    }
    const store = this.storeFor(paperToolScope);
    const filesDir = this.filesDir(paperToolScope);
    await mkdir(filesDir, { recursive: true });
    const imported = [];
    const duplicates = [];
    const failed = [];

    for (const file of files) {
      const name = typeof file?.name === "string" ? basename(file.name) : "untitled.pdf";
      try {
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
        const ocr = pageCount === 0 && input?.ocr !== false ? await this.#runOcr(bytes, extracted) : null;
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
        signal?.throwIfAborted();
      } catch (error) {
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
    return { imported, duplicates, failed, library: store.stats() };
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


  /** List library papers. */
  async listPapers(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    return {
      papers: store.listPapers({ limit: clampInt(input?.limit, 200, 1, 500), offset: clampInt(input?.offset, 0, 0, 1e6) }),
      library: store.stats(),
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
    const evidence = store
      .listEvidence({ limit: 5000 })
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
      ocrEvidence > 0
        ? `- OCR 文本：${ocrEvidence} 条证据来自 ${ocrPapers} 篇扫描件（这些引文由 OCR 识别，个别字可能有误，引用前请对照原文）`
        : null,
      warnings.length > 0 ? `- 核验提示：${warnings.length} 项，见文末` : "- 核验提示：无",
      "",
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

/** Words that flip a passage's stance; a cheap guard, not an NLI model. */
const NEGATIONS = ["not ", "no ", "did not", "fails to", "failed to", "no evidence", "没有", "并不", "未能", "无显著", "不支持", "相反"];

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
  "cnkiStatus",
  "cnkiConnect",
  "cnkiDisconnect",
  "cnkiSearch",
  "cnkiDownload",
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


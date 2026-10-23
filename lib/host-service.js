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
import { openStore, defaultDbPath } from "./store.js";
import { extractPdfPages, guessMetadata } from "./pdf-extract.js";
import { readPdfjsRuntime, readPdfjsAsset } from "./gui-assets.js";
import { availableStyles, renderBibliography } from "./citeproc.js";
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
const MAX_PDF_BYTES = 128 * 1024 * 1024;

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

  /** Lazily open one library per workspace (not per session). */
  storeFor(scope) {
    const root = scope.workspaceRoot;
    if (typeof root !== "string" || root === "") {
      throw new RemoteError("paper-tool/no-workspace", "this session has no workspace directory");
    }
    let store = this.stores.get(root);
    if (store === undefined) {
      const dbPath = this.config.dbPath ?? defaultDbPath(root);
      store = openStore(dbPath);
      this.stores.set(root, store);
    }
    return store;
  }

  /** Where imported PDF bytes live for this workspace. */
  filesDir(scope) {
    const root = scope.workspaceRoot;
    if (typeof root !== "string" || root === "") {
      throw new RemoteError("paper-tool/no-workspace", "this session has no workspace directory");
    }
    return join(root, ".dsh", "paper-tool", "files");
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
  async reviewOutline(paperToolScope, _input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const rows = store.evidenceByPaper({ limit: 500 });
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
    const rows = [];
    const papers = store.listPapers({ limit: 2000 });
    const evidenceRows = store.listEvidence({ limit: 2000 });
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
      if (coverageOnly) {
        for (const item of items) support.push(item);
      } else {
        const claimTerms = terms(claim);
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
      const stance = coverageOnly
        ? items.length > 0
          ? "covered"
          : "empty"
        : conflict.length > 0
          ? "conflict"
          : support.length > 0
            ? "support"
            : "not_found";
      if (requestedStance !== null && stance !== requestedStance) continue;
      rows.push({
        paperId: paper.paperId,
        title: paper.title || paper.paperId,
        year: paper.year,
        stance,
        evidenceIds: [...support, ...conflict].map((item) => item.evidenceId),
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
    const imported = importCandidates(store, clean);
    return { imported, library: store.stats() };
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
    return { ok: true, path: download.path, bytes: download.bytes, ...imported };
  }

  /** Render a bibliography in the requested CSL style, from stored metadata. */
  async formatCitations(paperToolScope, input) {
    assertScope(paperToolScope);
    const store = this.storeFor(paperToolScope);
    const styleId = typeof input?.style === "string" && input.style !== "" ? input.style : "apa";
    const locale = typeof input?.locale === "string" && input.locale !== "" ? input.locale : "en-US";
    const papers = store.papersForEvidence({ evidenceIds: input?.evidenceIds });
    if (papers.length === 0) {
      return {
        ok: false,
        styleId,
        bibliography: "",
        citation: "",
        entries: [],
        text: "还没有可引用的证据条目，先收集证据。",
      };
    }
    const rendered = await renderBibliography(papers, styleId, locale);
    const entries = papers.map((paper) => ({
      paperId: paper.paperId,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      doi: paper.doi,
    }));
    return {
      ok: rendered.ok,
      styleId: rendered.styleId,
      locale,
      reason: rendered.reason,
      bibliography: rendered.bibliography,
      citation: rendered.citation,
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
    const store = this.storeFor(paperToolScope);
    const filesDir = this.filesDir(paperToolScope);
    await mkdir(filesDir, { recursive: true });
    const imported = [];
    const failed = [];

    for (const file of files) {
      signal?.throwIfAborted();
      const name = typeof file?.name === "string" ? basename(file.name) : "untitled.pdf";
      try {
        const bytes = toUint8(file?.data);
        if (bytes.byteLength === 0) throw new Error("empty file");
        if (bytes.byteLength > MAX_PDF_BYTES) throw new Error(`exceeds ${MAX_PDF_BYTES} byte cap`);
        const extracted = await extractPdfPages(bytes);
        const guess = guessMetadata(extracted.pages);
        const pageCount = extracted.pages.filter((page) => page.trim() !== "").length;
        // Re-importing a file the library already holds must not create a
        // second entry: same bytes, same fingerprint, same paper.
        const existing = store.findByFingerprint(extracted.fingerprint);
        if (existing !== null) {
          imported.push({
            paperId: existing.paperId,
            title: existing.title,
            numPages: existing.numPages,
            pagesWithText: pageCount,
            fingerprint: extracted.fingerprint,
            material: existing.material,
            filename: name,
            duplicate: true,
          });
          continue;
        }
        const paperId = randomUUID();
        // Keep the original bytes: the reader and any re-index come from here.
        const pdfPath = join(filesDir, `${paperId}.pdf`);
        await writeFile(pdfPath, bytes);
        const paper = store.upsertPaper({
          paperId,
          title: typeof file.title === "string" && file.title !== "" ? file.title : guess.title,
          authors: typeof file.authors === "string" ? file.authors : "",
          year: typeof file.year === "string" && file.year !== "" ? file.year : guess.year,
          venue: typeof file.venue === "string" ? file.venue : "",
          doi: typeof file.doi === "string" && file.doi !== "" ? file.doi : guess.doi,
          abstract: typeof file.abstract === "string" ? file.abstract : "",
          source: "import",
          pdfPath,
          fingerprint: extracted.fingerprint,
          // Honest coverage: a PDF with no text layer is metadata-only, and the
          // UI must show that instead of implying full text is searchable.
          material: pageCount > 0 ? "fulltext" : "metadata",
          pages: extracted.pages,
        });
        imported.push({
          paperId: paper.paperId,
          title: paper.title,
          numPages: paper.numPages,
          pagesWithText: pageCount,
          fingerprint: extracted.fingerprint,
          material: paper.material,
          filename: name,
        });
      } catch (error) {
        failed.push({ filename: name, reason: error?.message ?? String(error) });
      }
    }
    return { imported, failed, library: store.stats() };
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
    // range, not just a page number.
    const pageText = store.getPageText(paperId, pageIndex) ?? "";
    const charStart = pageText.indexOf(quote);
    const evidence = store.addEvidence({
      evidenceId,
      paperId,
      pageIndex,
      charStart: charStart < 0 ? 0 : charStart,
      charEnd: charStart < 0 ? quote.length : charStart + quote.length,
      quote,
    });
    return { evidenceId: evidence.evidenceId, evidence, anchored: charStart >= 0 };
  }
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("unsupported file payload");
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

const STANCES = ["support", "conflict", "not_found"];

for (const method of [
  "status",
  "importPdf",
  "listPapers",
  "search",
  "readPaper",
  "getPdfRuntime",
  "getPdfAsset",
  "readPaperBytes",
  "deletePaper",
  "addEvidence",
  "collectEvidence",
  "listEvidence",
  "reviewOutline",
  "reviewMatrix",
  "formatCitations",
  "searchExternal",
  "addCandidates",
  "cnkiStatus",
  "cnkiConnect",
  "cnkiDisconnect",
  "cnkiSearch",
  "cnkiDownload",
]) {
  markRemote(PaperToolService, method);
}

export { SERVICE_KEY, LOOKUP };

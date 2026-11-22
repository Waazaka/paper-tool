// Agent tools for the paper tool.
//
// One operation, two callers: each tool calls the same service method the
// sidebar uses, so there is no second implementation to drift.
//
// Five tools, deliberately. Schema cost is paid on every request (the Zotero
// MCP precedent measured 38 tools at ~13k tokens per request), so related
// operations share one tool with an `action` parameter.
import { defineTool } from "@deepseek-ai/dsh-tools";

const STANCES = ["support", "conflict", "not_found"];

/**
 * Register the paper tools on ctx.tools.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {() => object} getService returns the live PaperToolService
 */
export function registerPaperTools(ctx, getService) {
  const withScope = (exec) => {
    // The agent runs inside a session; the service needs that session's
    // workspace to pick the right library.
    const sessionId = exec?.agent?.session?.id ?? exec?.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("paper tools require an owning agent session");
    }
    return { sessionId, workspaceRoot: exec?.agent?.session?.header?.cwd ?? null };
  };

  ctx.tools.register(
    defineTool({
      name: "paper_search",
      description:
        "Search for papers. scope=library searches the user's local library (page-level full text); " +
        "scope=external queries OpenAlex/Crossref/arXiv for NEW candidates that are not in the library yet. " +
        "External hits are not in the library until you call paper_import. " +
        "material=fulltext means the PDF text was indexed; " +
        "material=ocr means the PDF had no text layer and its text was recognised from page " +
        "images, so individual characters may be wrong — quote it only as what the scan appears " +
        "to say; metadata means only bibliographic fields exist.",
      parameters: {
        query: { type: "string", required: true, description: "Keywords. Chinese and English both work." },
        scope: {
          type: "string",
          enum: ["library", "external", "cnki"],
          description: "library (default) | external (OpenAlex/Crossref/arXiv) | cnki (needs a login first)",
        },
        limit: { type: "integer", description: "Max hits (default 20 local / 10 external)." },
        sources: {
          type: "array",
          items: { type: "string", enum: ["openalex", "crossref", "arxiv", "semanticscholar", "pubmed"] },
          description:
            "scope=external only: query just these sources instead of all five. Useful when one " +
            "source is rate-limited, or when the question is field-specific (pubmed = biomedical).",
        },
        sort: {
          type: "string",
          enum: ["relevance", "citations", "year"],
          description:
            "scope=external only: relevance (default) | citations (most cited first) | year (newest first). " +
            "Sources that publish no citation counts (arXiv, PubMed) are ordered after counted ones " +
            "rather than being ranked as zero.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", required: true },
            scope: { type: "string", required: true },
            count: { type: "integer", required: true },
            hits: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  paperId: { type: "string" },
                  title: { type: "string", required: true },
                  authors: { type: "string" },
                  year: { type: "string" },
                  venue: { type: "string" },
                  doi: { type: "string" },
                  pageIndex: { type: "integer" },
                  snippet: { type: "string" },
                  material: { type: "string" },
                  source: { type: "string" },
                  pdfUrl: { type: "string" },
                  abstract: { type: "string" },
                  // External hits only, and absent rather than 0 when the source does not
                  // publish counts — a real 0 ("nobody cited this") and an unknown must not
                  // look the same to the model reading the result.
                  citations: { type: "integer" },
                },
              },
            },
            failures: { type: "array", items: { type: "string" } },
            library: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                papers: { type: "integer", required: true },
                withFullText: { type: "integer", required: true },
                pages: { type: "integer", required: true },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.count === 0) {
            const note = value.failures?.length ? ` (sources failed: ${value.failures.join(", ")})` : "";
            return [{ type: "text", text: `No matches for "${value.query}" via ${value.scope}${note}.` }];
          }
          const lines = value.hits.map((hit) => {
            if (value.scope === "external") {
              const meta = [
                hit.venue ? hit.venue : null,
                typeof hit.citations === "number" ? `cited:${hit.citations}` : null,
                hit.doi ? `doi:${hit.doi}` : null,
                hit.pdfUrl ? "PDF available" : null,
              ]
                .filter(Boolean)
                .join(" · ");
              const abs = hit.abstract
                ? `\n  ${hit.abstract.length > 220 ? `${hit.abstract.slice(0, 220)}…` : hit.abstract}`
                : "";
              return `- ${hit.title}${hit.year ? ` (${hit.year})` : ""} [${hit.source}]${meta ? ` · ${meta}` : ""}${abs}`;
            }
            return `- ${hit.title} [${hit.paperId}] ${hit.pageIndex === undefined ? "(metadata)" : `p.${hit.pageIndex + 1}`} · ${hit.material}\n  ${hit.snippet ?? ""}`;
          });
          return [{ type: "text", text: `${value.count} hit(s) for "${value.query}" (${value.scope}):\n${lines.join("\n")}` }];
        },
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        const kind = args.scope === "external" ? "external" : args.scope === "cnki" ? "cnki" : "library";
        const library = (await service.status(scope)).library;

        if (kind === "cnki") {
          const result = await service.cnkiSearch(scope, { query: args.query, limit: args.limit ?? 20 });
          if (result.ok !== true) {
            return {
              query: args.query,
              scope: "cnki",
              count: 0,
              hits: [],
              failures: [result.reason ?? "CNKI unavailable"],
              library: { papers: library.papers, withFullText: library.withFullText, pages: library.pages },
            };
          }
          return {
            query: args.query,
            scope: "cnki",
            count: result.count,
            hits: result.results.map((row) => ({
              title: row.title,
              authors: row.authors,
              year: (/(\d{4})/.exec(row.date ?? "") ?? [])[1] ?? "",
              venue: row.venue,
              material: "metadata",
              source: "cnki",
              ...(row.href ? { pdfUrl: row.href } : {}),
            })),
            failures: [],
            library: { papers: library.papers, withFullText: library.withFullText, pages: library.pages },
          };
        }

        if (kind === "external") {
          const external = await service.searchExternal(scope, {
            query: args.query,
            limit: args.limit ?? 10,
            sources: Array.isArray(args.sources) && args.sources.length > 0 ? args.sources : undefined,
            sort: args.sort,
          });
          return {
            query: external.query,
            scope: "external",
            count: external.candidates.length,
            hits: external.candidates.map((candidate) => ({
              title: candidate.title,
              authors: candidate.authors,
              year: candidate.year,
              venue: candidate.venue,
              doi: candidate.doi,
              material: "metadata",
              source: candidate.source,
              ...(candidate.pdfUrl ? { pdfUrl: candidate.pdfUrl } : {}),
              ...(candidate.abstract
                ? { abstract: String(candidate.abstract).replace(/\s+/g, " ").trim().slice(0, 500) }
                : {}),
              // Omitted, not 0, when the source publishes no counts: "unknown" and "cited
              // by nobody" are different facts and the model should not conflate them.
              ...(candidate.citationsKnown === false ? {} : { citations: candidate.citations ?? 0 }),
            })),
            failures: external.failures.map((failure) => `${failure.source}: ${failure.reason}`),
            library: { papers: library.papers, withFullText: library.withFullText, pages: library.pages },
          };
        }

        const result = await service.search(scope, { query: args.query, limit: args.limit ?? 20 });
        return {
          query: result.query,
          scope: "library",
          count: result.hits.length,
          hits: result.hits.map((hit) => ({
            paperId: hit.paperId,
            title: hit.title || hit.paperId,
            ...(typeof hit.pageIndex === "number" ? { pageIndex: hit.pageIndex } : {}),
            ...(hit.year ? { year: hit.year } : {}),
            snippet: hit.snippet ?? "",
            material: hit.material ?? "metadata",
          })),
          failures: [],
          library: {
            papers: result.library.papers,
            withFullText: result.library.withFullText,
            pages: result.library.pages,
          },
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `Search papers (${args.scope ?? "library"}): ${args.query}`,
        kind: "search",
        rawInput: args,
      }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "paper_import",
      description:
        "Save external search candidates into the user's library as metadata-only entries. " +
        "Call this after paper_search scope=external, passing the candidates you actually want. " +
        "These entries have no PDF, so their full text is not searchable — import the PDF separately if the user has it.",
      parameters: {
        candidates: {
          type: "array",
          required: true,
          description: "Candidate objects from paper_search scope=external.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", required: true },
              authors: { type: "string" },
              year: { type: "string" },
              venue: { type: "string" },
              doi: { type: "string" },
              abstract: { type: "string" },
              source: { type: "string" },
            },
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            added: { type: "integer", required: true },
            skipped: { type: "integer", required: true },
            titles: { type: "array", required: true, items: { type: "string" } },
            libraryPapers: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `Added ${value.added} paper(s) to the library (now ${value.libraryPapers} total)${value.skipped > 0 ? `; ${value.skipped} already present by DOI` : ""}:\n${value.titles.map((title) => `- ${title}`).join("\n")}`,
          },
        ],
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        const result = await service.addCandidates(scope, { candidates: args.candidates });
        return {
          added: result.imported.length,
          skipped: (result.duplicates ?? []).length,
          titles: result.imported.map((paper) => paper.title),
          libraryPapers: result.library.papers,
        };
      },
      presentCall: (args) => ({ card: "generic", title: `Import ${args.candidates.length} candidates`, kind: "other", rawInput: args }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "paper_read",
      description:
        "Read extracted page text of one paper. Reports actual coverage rather than implying the whole file was read. " +
        "Use paper_search first to get a paperId. With action=context it instead builds a question packet " +
        "anchored to a specific passage, which is what makes an answer citable.",
      parameters: {
        paperId: { type: "string", required: true, description: "paperId from paper_search." },
        fromPage: { type: "integer", description: "First page (0-based, default 0)." },
        toPage: { type: "integer", description: "End page exclusive (default fromPage+3)." },
        action: {
          type: "string",
          enum: ["pages", "context"],
          description:
            "pages (default): return page text. " +
            "context: build a question-answering packet — the selected passage with its page and " +
            "character anchor, plus a bounded window of surrounding text. Use context when asked a " +
            "question about a specific passage, so the answer can cite the exact location.",
        },
        question: {
          type: "string",
          description: "With action=context: the question to answer from the selection.",
        },
        selectionText: {
          type: "string",
          description:
            "With action=context: the passage the question is about. Its page and character " +
            "offsets are located in the stored text, never taken from the caller.",
        },
      },
      output: {
        schema: {
          // One object rather than a oneOf union: this DSH build rejects a schema that
          // declares both `type` and `oneOf` ("cannot declare both type and oneOf"),
          // and dropping `type` is not an option either. So the pages-shape fields stay
          // required and the context-shape fields are optional — `action` tells the
          // caller which set is populated. Less elegant than a union, but it is the
          // shape the protocol actually accepts, and a schema that fails to register
          // means the tool does not exist at all.
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", required: true },
            // pages shape
            title: { type: "string", required: true },
            numPages: { type: "integer", required: true },
            material: { type: "string", required: true },
            // context shape
            paperId: { type: "string" },
            question: { type: "string" },
            pageIndex: { type: "integer" },
            charStart: { type: "integer" },
            charEnd: { type: "integer" },
            anchored: { type: "boolean" },
            selectionText: { type: "string" },
            contextText: { type: "string" },
            // pages shape (the paging counters; 0 for a context packet)
            returned: { type: "integer" },
            truncated: { type: "boolean" },
            text: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.action === "context") {
            const where = value.anchored
              ? `page ${value.pageIndex + 1}, chars ${value.charStart}-${value.charEnd}`
              : `page ${value.pageIndex + 1}, anchor NOT located`;
            return [
              {
                type: "text",
                text:
                  `${value.title} — ${where}\n` +
                  `Question: ${value.question}\n` +
                  (value.anchored
                    ? ""
                    : "NOTE: the selected passage could not be located verbatim in the stored page text. " +
                      "Do not claim an exact location for the quote; say what the passage appears to say.\n") +
                  (value.material === "ocr"
                    ? "NOTE: this page text came from OCR; characters may be wrong.\n"
                    : "") +
                  `\n--- selected passage ---\n${value.selectionText}\n\n--- surrounding text ---\n${value.contextText}`,
              },
            ];
          }
          return [
            {
              type: "text",
              text:
                `${value.title} (${value.numPages}p, ${value.material}); returned ${value.returned} page(s)${value.truncated ? ", truncated to fit the response limit" : ""}:\n` +
                // Say it where the model actually reads the text, not only in the
                // tool description: OCR text is guessed from an image, and a
                // misread glyph silently becomes a wrong quote otherwise.
                (value.material === "ocr"
                  ? "NOTE: this page text came from OCR of scanned images, not from a text layer. Characters may be wrong; quote it only as what the scan appears to say, never as an exact verbatim quotation.\n"
                  : "") +
                `\n${value.text}`,
            },
          ];
        },
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        // action=context answers "what does this passage say, and where is it" — the
        // packet is built by the Host from stored text (D-014), so the anchors are
        // computed from content rather than from whatever the caller claims.
        if (args.action === "context") {
          const packet = await service.askContext(scope, {
            paperId: args.paperId,
            question: args.question ?? "",
            selectionText: args.selectionText ?? "",
            pageIndex: args.fromPage ?? -1,
          });
          return {
            action: "context",
            paperId: packet.paperId,
            title: packet.title,
            question: packet.question,
            pageIndex: packet.selection.pageIndex,
            charStart: packet.selection.charStart,
            charEnd: packet.selection.charEnd,
            anchored: packet.selection.anchored,
            selectionText: packet.selection.text,
            material: packet.coverage.material,
            contextText: packet.context.text,
          };
        }
        const from = args.fromPage ?? 0;
        const to = args.toPage ?? from + 3;
        const result = await service.readPaper(scope, { paperId: args.paperId, fromPage: from, toPage: to });
        // Build the text page by page and stop at the cap, so `returned`
        // describes what is actually in `text`. Slicing the joined string would
        // report three pages while delivering half of one.
        const LIMIT = 60000;
        const chunks = [];
        let used = 0;
        let returned = 0;
        let truncated = false;
        for (const page of result.pages) {
          const block = `--- page ${page.pageIndex + 1} ---\n${page.text}`;
          if (used + block.length > LIMIT) {
            const room = LIMIT - used;
            if (room > 200) {
              chunks.push(block.slice(0, room));
              used += room;
              returned += 1;
            }
            truncated = true;
            break;
          }
          chunks.push(block);
          used += block.length;
          returned += 1;
        }
        return {
          action: "pages",
          title: result.paper.title || result.paper.paperId,
          numPages: result.paper.numPages,
          material: result.paper.material,
          returned,
          truncated,
          text: chunks.join("\n\n"),
        };
      },
      presentCall: (args) => ({ card: "generic", title: "Read paper", kind: "read", rawInput: args }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "paper_evidence",
      description:
        "Find, record, manage, and segment-translate cited evidence in the library. action=collect searches page text " +
        "and saves matching passages as evidence rows; action=list returns saved evidence; action=add stores a verbatim " +
        "quote (<=500 chars) on a page; action=delete removes one evidence row by evidenceId; action=save_answer writes " +
        "a Q&A answer back as a note or evidence+note at a passage anchor — it can also save a structured per-paper reading " +
        "card (kind=\"note\", question=\"读书卡\", answer covering 研究问题/方法/数据/结论/局限); action=segments splits paper " +
        "pages into anchor-exact segments (pageIndex, charStart, charEnd, source) for translation; action=save_segments stores " +
        "translated segments against those exact anchors.",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["collect", "list", "add", "delete", "save_answer", "segments", "save_segments"],
          description: "collect | list | add | delete | save_answer | segments | save_segments",
        },
        query: { type: "string", description: "Required for action=collect: the passage topic to search." },
        paperId: {
          type: "string",
          description: "Paper id. Optional for collect/list; required for add, save_answer, segments, save_segments.",
        },
        paperIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional working-set paperIds filter for action=collect/list.",
        },
        limit: { type: "integer", description: "Max results for collect/list (default 10)." },
        pageIndex: { type: "integer", description: "0-based page index for action=add or action=save_answer." },
        quote: {
          type: "string",
          description: "Verbatim passage (<=500 chars) for action=add, or source quote for action=save_answer (required when kind=evidence).",
        },
        evidenceId: { type: "string", description: "Required for action=delete: evidenceId to remove." },
        question: {
          type: "string",
          description: "For action=save_answer: the question asked about the passage, or \"读书卡\" when saving a structured paper reading card.",
        },
        answer: {
          type: "string",
          description: "Required for action=save_answer: the answer text or structured reading card (研究问题/方法/数据/结论/局限) to store.",
        },
        kind: {
          type: "string",
          enum: ["note", "evidence"],
          description: "For action=save_answer: note (annotation/reading card only) or evidence (annotation + evidence row; requires quote).",
        },
        charStart: { type: "integer", description: "For action=save_answer: 0-based start offset in page text." },
        charEnd: { type: "integer", description: "For action=save_answer: 0-based end offset in page text." },
        fromPage: { type: "integer", description: "For action=segments: first page (0-based, default 0)." },
        toPage: { type: "integer", description: "For action=segments: last page inclusive (0-based, default fromPage)." },
        targetLang: { type: "string", description: "For action=segments/save_segments: target language code, e.g. zh, en." },
        items: {
          type: "array",
          description: "Required for action=save_segments: translated segments anchored to original offsets.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              pageIndex: { type: "integer", required: true },
              charStart: { type: "integer", required: true },
              charEnd: { type: "integer", required: true },
              text: { type: "string", required: true },
            },
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", required: true },
            count: { type: "integer", required: true },
            evidence: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  evidenceId: { type: "string", required: true },
                  paperId: { type: "string", required: true },
                  pageIndex: { type: "integer", required: true },
                  quote: { type: "string", required: true },
                  charStart: { type: "integer" },
                  charEnd: { type: "integer" },
                },
              },
            },
            evidenceId: { type: "string" },
            annotationId: { type: "string" },
            kind: { type: "string" },
            anchored: { type: "boolean" },
            deleted: { type: "string" },
            paperId: { type: "string" },
            title: { type: "string" },
            fromPage: { type: "integer" },
            toPage: { type: "integer" },
            totalPages: { type: "integer" },
            targetLang: { type: "string" },
            translated: { type: "integer" },
            untranslated: { type: "integer" },
            aligned: { type: "boolean" },
            ocrPages: { type: "array", items: { type: "integer" } },
            segments: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  segmentId: { type: "string", required: true },
                  pageIndex: { type: "integer", required: true },
                  charStart: { type: "integer", required: true },
                  charEnd: { type: "integer", required: true },
                  source: { type: "string", required: true },
                  textSource: { type: "string" },
                },
              },
            },
            saved: { type: "integer" },
            rejected: { type: "integer" },
            rejectedDetails: { type: "array", items: { type: "string" } },
          },
        },
        render: (_args, value) => {
          if (value.action === "add") {
            const row = value.evidence[0];
            const anchorNote = value.anchored ? `anchored ${row?.charStart}-${row?.charEnd}` : "unanchored";
            return [
              {
                type: "text",
                text: `Added evidence [${value.evidenceId}] on ${row?.paperId ?? ""} p.${(row?.pageIndex ?? 0) + 1} (${anchorNote}): "${(row?.quote ?? "").slice(0, 160)}"`,
              },
            ];
          }
          if (value.action === "delete") {
            return [{ type: "text", text: `Deleted evidence ${value.deleted}.` }];
          }
          if (value.action === "save_answer") {
            if (value.kind === "evidence") {
              const row = value.evidence[0];
              return [
                {
                  type: "text",
                  text: `Saved answer as evidence [${value.evidenceId}] and note [${value.annotationId}] on p.${(row?.pageIndex ?? 0) + 1}.`,
                },
              ];
            }
            return [{ type: "text", text: `Saved answer as note [${value.annotationId}].` }];
          }
          if (value.action === "segments") {
            const ocrNote =
              value.ocrPages && value.ocrPages.length > 0
                ? `\nNOTE: page(s) ${value.ocrPages.map((p) => p + 1).join(", ")} came from OCR; characters may be wrong.`
                : "";
            const lines = (value.segments ?? []).map(
              (seg) =>
                `- pageIndex=${seg.pageIndex} charStart=${seg.charStart} charEnd=${seg.charEnd} [${seg.textSource ?? "text-layer"}]\n  ${seg.source}`,
            );
            return [
              {
                type: "text",
                text:
                  `${value.title ?? value.paperId} (pages ${(value.fromPage ?? 0) + 1}-${(value.toPage ?? 0) + 1} of ${value.totalPages ?? 0}, targetLang=${value.targetLang || "(default)"}): ` +
                  `${value.count} segment(s) (${value.translated ?? 0} translated, ${value.untranslated ?? 0} untranslated, aligned=${Boolean(value.aligned)})` +
                  `${ocrNote}${lines.length > 0 ? `\n\n${lines.join("\n")}` : ""}`,
              },
            ];
          }
          if (value.action === "save_segments") {
            const detail = value.rejectedDetails?.length ? `\nRejected:\n${value.rejectedDetails.map((r) => `- ${r}`).join("\n")}` : "";
            return [
              {
                type: "text",
                text: `Saved ${value.saved ?? 0} translation segment(s) for ${value.paperId} (rejected=${value.rejected ?? 0}, aligned=${Boolean(value.aligned)}).${detail}`,
              },
            ];
          }
          return [
            {
              type: "text",
              text:
                value.count === 0
                  ? "No evidence found."
                  : `${value.count} evidence row(s):\n${value.evidence
                      .map((row) => `- [${row.evidenceId.slice(0, 8)}] ${row.paperId} p.${row.pageIndex + 1}: "${row.quote.slice(0, 160)}"`)
                      .join("\n")}`,
            },
          ];
        },
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        const limit = args.limit ?? 10;
        if (args.action === "list") {
          const paperIds = Array.isArray(args.paperIds) && args.paperIds.length > 0 ? args.paperIds : undefined;
          const rows = await service.listEvidence(scope, {
            paperId: args.paperId,
            ...(paperIds ? { paperIds } : {}),
            limit,
          });
          return {
            action: "list",
            count: rows.evidence.length,
            evidence: rows.evidence.map((row) => ({
              evidenceId: row.evidenceId,
              paperId: row.paperId,
              pageIndex: row.pageIndex,
              quote: row.quote,
            })),
          };
        }
        if (args.action === "add") {
          const res = await service.addEvidence(scope, {
            paperId: args.paperId,
            pageIndex: args.pageIndex,
            quote: args.quote,
          });
          return {
            action: "add",
            count: 1,
            evidence: [
              {
                evidenceId: res.evidence.evidenceId,
                paperId: res.evidence.paperId,
                pageIndex: res.evidence.pageIndex,
                quote: res.evidence.quote,
                ...(typeof res.evidence.charStart === "number" ? { charStart: res.evidence.charStart } : {}),
                ...(typeof res.evidence.charEnd === "number" ? { charEnd: res.evidence.charEnd } : {}),
              },
            ],
            evidenceId: res.evidenceId,
            anchored: res.anchored,
          };
        }
        if (args.action === "delete") {
          const res = await service.deleteEvidence(scope, { evidenceId: args.evidenceId });
          return {
            action: "delete",
            count: 0,
            evidence: [],
            deleted: res.deleted,
          };
        }
        if (args.action === "save_answer") {
          const res = await service.saveAnswer(scope, {
            paperId: args.paperId,
            pageIndex: args.pageIndex,
            charStart: args.charStart,
            charEnd: args.charEnd,
            question: args.question,
            answer: args.answer,
            sourceQuote: args.quote,
            kind: args.kind,
          });
          return {
            action: "save_answer",
            count: res.kind === "evidence" ? 1 : 0,
            evidence:
              res.kind === "evidence"
                ? [
                    {
                      evidenceId: res.evidenceId,
                      paperId: args.paperId,
                      pageIndex: res.pageIndex,
                      quote: String(args.quote ?? "").trim(),
                    },
                  ]
                : [],
            kind: res.kind,
            annotationId: res.annotationId,
            ...(res.evidenceId ? { evidenceId: res.evidenceId } : {}),
          };
        }
        if (args.action === "segments") {
          const res = await service.translateSegments(scope, {
            paperId: args.paperId,
            fromPage: args.fromPage,
            toPage: args.toPage,
            targetLang: args.targetLang,
          });
          return {
            action: "segments",
            count: res.segments.length,
            evidence: [],
            paperId: res.paperId,
            title: res.title,
            fromPage: res.fromPage,
            toPage: res.toPage,
            totalPages: res.totalPages,
            targetLang: res.targetLang,
            translated: res.translated,
            untranslated: res.untranslated,
            aligned: res.aligned,
            ocrPages: res.ocrPages,
            segments: res.segments.map((seg) => ({
              segmentId: seg.segmentId,
              pageIndex: seg.pageIndex,
              charStart: seg.charStart,
              charEnd: seg.charEnd,
              source: seg.text,
              textSource: seg.textSource,
            })),
          };
        }
        if (args.action === "save_segments") {
          const res = await service.saveTranslation(scope, {
            paperId: args.paperId,
            targetLang: args.targetLang,
            items: args.items,
          });
          return {
            action: "save_segments",
            count: res.saved,
            evidence: [],
            paperId: res.paperId,
            saved: res.saved,
            rejected: res.rejected.length,
            aligned: res.aligned,
            ...(res.rejected.length > 0 ? { rejectedDetails: res.rejected.map((r) => String(r.reason ?? "rejected")) } : {}),
          };
        }
        if (typeof args.query !== "string" || args.query.trim() === "") {
          throw new Error("paper_evidence action=collect requires `query`");
        }
        const paperIds = Array.isArray(args.paperIds) && args.paperIds.length > 0 ? args.paperIds : undefined;
        const collected = await service.collectEvidence(scope, {
          query: args.query,
          paperId: args.paperId,
          ...(paperIds ? { paperIds } : {}),
          limit,
        });
        return {
          action: "collect",
          count: collected.evidence.length,
          evidence: collected.evidence.map((row) => ({
            evidenceId: row.evidenceId,
            paperId: row.paperId,
            pageIndex: row.pageIndex,
            quote: row.quote,
          })),
        };
      },
      presentCall: (args) => ({ card: "generic", title: `Evidence: ${args.action}`, kind: "search", rawInput: args }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "paper_review",
      description:
        "Build a traceable review draft from the library or gather counted research-direction material. " +
        "action=outline lists the evidence grouped by paper; action=matrix returns the claim x paper evidence matrix; " +
        "action=citations formats references in the requested CSL style; action=claims lists recorded claims; " +
        "action=record_claims records claims bound to existing evidenceIds; action=skeleton proposes evidence-bound review sections; " +
        "action=bodyplan builds sentence slots bound to evidence; action=body renders filled slots into anchored prose; " +
        "action=export writes review.md and references.bib into the workspace; action=direction analyzes external literature " +
        "trends and co-occurrence gaps for a query. All output is grounded in stored evidence — never invent citations.",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["outline", "matrix", "citations", "export", "claims", "record_claims", "skeleton", "bodyplan", "body", "direction"],
          description: "outline | matrix | citations | export | claims | record_claims | skeleton | bodyplan | body | direction",
        },
        style: { type: "string", description: "For action=citations/export: CSL style id, e.g. apa, ieee, chicago-author-date." },
        section: { type: "string", description: "For action=bodyplan/body/export: section heading for the generated text." },
        limit: {
          type: "integer",
          description: "For action=bodyplan (default 200), action=skeleton (default 2000), or action=direction (20-100, default 60).",
        },
        claim: { type: "string", description: "For action=matrix: the claim to check against collected evidence." },
        stance: { type: "string", enum: STANCES, description: "For action=matrix: how the evidence relates to the claim." },
        evidenceIds: { type: "array", items: { type: "string" }, description: "For action=matrix/citations/export/bodyplan/body: evidence to include." },
        paperIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional working-set paperIds filter for action=outline/matrix/citations/skeleton/bodyplan/body/export.",
        },
        claims: {
          type: "array",
          description:
            "For action=export or action=record_claims: the draft's sentences, each bound to stored evidence. " +
            "Shape: [{claimId?, text, section?, evidenceIds? | evidence?: [{evidenceId, stance?, strength?}]}]. " +
            "Every evidenceId must already exist — an invented id is rejected, never stored.",
        },
        includeStoredClaims: {
          type: "boolean",
          description: "For action=export: when true and claims is omitted, include previously recorded claims from the library.",
        },
        sentences: {
          type: "array",
          description:
            "For action=body/export: the filled body plan. Shape: [{slotId, text, evidenceIds?}]. " +
            "Each slotId must come from action=bodyplan, and evidenceIds must be ids that slot " +
            "was bound to. A sentence whose anchor does not resolve is rejected, not rendered. " +
            "Omit evidenceIds to use the slot's own binding.",
        },
        query: {
          type: "string",
          description: "Required for action=direction: research topic keywords to gather trend and co-occurrence gap statistics.",
        },
        sources: {
          type: "array",
          items: { type: "string", enum: ["openalex", "crossref", "arxiv", "semanticscholar", "pubmed"] },
          description: "For action=direction: external sources to query instead of all five.",
        },
        minSample: {
          type: "integer",
          description: "For action=direction: minimum dated sample floor required before producing candidates.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", required: true },
            text: { type: "string", required: true },
            data: { type: "string", description: "JSON payload for structured follow-up." },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        const paperIds = Array.isArray(args.paperIds) && args.paperIds.length > 0 ? args.paperIds : undefined;
        if (args.action === "outline") {
          const result = await service.reviewOutline(scope, paperIds ? { paperIds } : {});
          return { action: "outline", text: result.text, data: JSON.stringify(result.groups) };
        }
        if (args.action === "matrix") {
          const result = await service.reviewMatrix(scope, {
            claim: args.claim,
            stance: args.stance,
            evidenceIds: args.evidenceIds,
            ...(paperIds ? { paperIds } : {}),
          });
          return { action: "matrix", text: result.text, data: JSON.stringify(result.rows) };
        }
        if (args.action === "claims") {
          // No `claims` payload: this branch is read-only, reporting what has been
          // recorded so far. Writing claims goes through `recordClaims`, called by
          // `paper_review action=record_claims` or `paper_review action=export`.
          const result = await service.listClaims(scope, {});
          const lines = result.claims.map((claim) => {
            const tags = claim.evidence.map((row) => `[E:${row.evidenceId.slice(0, 8)}]`).join(" ");
            return `- ${claim.text}${tags ? ` ${tags}` : " （无证据）"}`;
          });
          return {
            action: "claims",
            text: result.claims.length === 0
              ? "还没有记录任何论断。用 action=export 导出时会把你给出的 claims 一并写入。"
              : `共 ${result.summary.total} 条论断（${result.summary.supported} 条有证据，${result.summary.unsupported} 条缺证据）：\n${lines.join("\n")}`,
            data: JSON.stringify({ claims: result.claims, summary: result.summary }),
          };
        }
        if (args.action === "record_claims") {
          const result = await service.recordClaims(scope, { claims: args.claims });
          const lines = [
            `已记录 ${result.accepted.length} 条论断` +
              (result.unsupported.length > 0 ? `（其中 ${result.unsupported.length} 条缺证据）` : "") +
              (result.rejected.length > 0 ? `；${result.rejected.length} 条被拒绝（引用了不存在的证据）` : ""),
          ];
          if (result.rejected.length > 0) {
            lines.push("被拒绝：", ...result.rejected.map((r) => `- ${r.text || "(空)"}：${r.reason}`));
          }
          if (result.unsupported.length > 0) {
            lines.push("待补充证据：", ...result.unsupported.map((u) => `- ${u.text}`));
          }
          return {
            action: "record_claims",
            text: lines.join("\n"),
            data: JSON.stringify(result),
          };
        }
        if (args.action === "skeleton") {
          const result = await service.sectionSkeleton(scope, {
            limit: args.limit,
            ...(paperIds ? { paperIds } : {}),
          });
          return {
            action: "skeleton",
            text: result.text,
            data: JSON.stringify({
              sections: result.sections,
              totalEvidence: result.totalEvidence,
              droppedEvidence: result.droppedEvidence,
              note: result.note,
            }),
          };
        }
        if (args.action === "direction") {
          const result = await service.topicRecommend(
            scope,
            {
              query: args.query,
              limit: args.limit,
              minSample: args.minSample,
              sources: Array.isArray(args.sources) && args.sources.length > 0 ? args.sources : undefined,
            },
            exec?.signal,
          );
          if (result.refusal !== null) {
            const failures = result.provenance?.failures?.length
              ? `\n失败数据源：${result.provenance.failures.map((f) => `${f.source}: ${f.reason}`).join("；")}`
              : "";
            return {
              action: "direction",
              text:
                `选题统计不足（${result.query}）：共检索 ${result.sample.papers} 篇（库内已有 ${result.alreadyInLibrary} 篇）。\n` +
                `${result.refusal.message}${failures}\n\n${result.disclaimer}`,
              data: JSON.stringify(result),
            };
          }
          const gapLines = (result.gaps ?? [])
            .slice(0, 6)
            .map((g) => `- ${g.terms.join(" × ")}（共现 ${g.coOccurrences} 次，独立出现 ${g.independentA}/${g.independentB}）`);
          const candidateLines = (result.candidates ?? [])
            .slice(0, 6)
            .map((c) => `- ${c.title}：${c.researchQuestion}（依据：${c.innovation?.note ?? ""}）`);
          const repLines = (result.representatives ?? [])
            .slice(0, 5)
            .map((r) => `- ${r.title}${r.year ? ` (${r.year})` : ""}${typeof r.citations === "number" ? ` [引用 ${r.citations}]` : ""}`);
          const sections = [
            `选题统计（${result.query}）：样本 ${result.sample.papers} 篇（有效年份 ${result.sample.dated} 篇，库内已有 ${result.alreadyInLibrary} 篇），趋势 ${result.trend.direction}（${result.trend.window.from}-${result.trend.window.to}）`,
            ...(gapLines.length > 0 ? ["", "共现组合：", ...gapLines] : []),
            ...(candidateLines.length > 0 ? ["", "候选方向：", ...candidateLines] : []),
            ...(repLines.length > 0 ? ["", "高引代表文献：", ...repLines] : []),
            "",
            result.disclaimer,
          ];
          return {
            action: "direction",
            text: sections.join("\n"),
            data: JSON.stringify(result),
          };
        }
        if (args.action === "bodyplan") {
          const result = await service.reviewBodyPlan(scope, {
            section: args.section,
            evidenceIds: args.evidenceIds,
            ...(paperIds ? { paperIds } : {}),
            limit: args.limit,
          });
          return {
            action: "bodyplan",
            text: result.ok
              ? result.text
              : `无法生成正文骨架：${result.reason}`,
            data: JSON.stringify(result.ok ? { section: result.section, slots: result.slots } : { reason: result.reason }),
          };
        }
        if (args.action === "body") {
          const result = await service.renderBody(scope, {
            section: args.section,
            sentences: args.sentences,
            evidenceIds: args.evidenceIds,
            ...(paperIds ? { paperIds } : {}),
          });
          if (!result.ok) {
            const scoped = Array.isArray(args.evidenceIds) && args.evidenceIds.length > 0
              ? `（已按你指定的 ${args.evidenceIds.length} 条证据筛选）`
              : "";
            return {
              action: "body",
              text: `无法生成正文${scoped}：${result.reason}`,
              data: JSON.stringify({ reason: result.reason }),
            };
          }
          const notes = [];
          if (result.summary.rejected > 0) {
            notes.push(`${result.summary.rejected} 句被拒绝（锚点无法解析：槽位不存在、证据不属于该槽位、证据已失效或句子为空）`);
          }
          if (result.summary.unsupported > 0) {
            notes.push(`${result.summary.unsupported} 句缺证据，已列入「待补充证据」`);
          }
          return {
            action: "body",
            text:
              `已生成 ${result.summary.accepted} 句正文（覆盖 ${result.summary.slots} 个槽位）` +
              (notes.length > 0 ? `；${notes.join("；")}` : "") +
              (result.rejected.length > 0 ? `\n\n被拒绝的句子：\n${result.rejected.map((r) => `- ${r.reason}`).join("\n")}` : "") +
              (result.unsupported.length > 0 ? `\n\n待补充证据：\n${result.unsupported.map((u) => `- ${u.text}`).join("\n")}` : ""),
            data: JSON.stringify(result),
          };
        }
        if (args.action === "export") {
          const result = await service.exportReview(scope, {
            style: args.style ?? "apa",
            // Only anchored evidence can be cited; saying so explicitly keeps the
            // export from depending on the Host's default.
            anchor: "anchored",
            evidenceIds: args.evidenceIds,
            ...(paperIds ? { paperIds } : {}),
            claims: args.claims,
            includeStoredClaims: args.includeStoredClaims,
            sentences: args.sentences,
            bodySection: args.section,
          });
          // Excluded, not silently lost: unanchored evidence cannot be cited, so the
          // count is reported whether the export succeeded or refused.
          const excluded = typeof result.unanchoredCount === "number" && result.unanchoredCount > 0
            ? `；另有 ${result.unanchoredCount} 条未定位证据无法引用，已排除`
            : "";
          // A refusal is about the evidence this call was given, not about the
          // library: say which set was searched instead of reporting "no evidence".
          const requested = Array.isArray(args.evidenceIds) && args.evidenceIds.length > 0
            ? `（已按你指定的 ${args.evidenceIds.length} 条证据筛选）`
            : "";
          return {
            action: "export",
            text: (result.ok
              ? `已导出 ${result.evidenceCount} 条证据（${result.paperCount} 篇论文）到 ${result.paths.dir}` +
                (result.claims === undefined ? "" : `，其中 ${result.claims.accepted} 条论断已绑定证据` +
                  (result.claims.rejected > 0 ? `，${result.claims.rejected} 条被拒绝（证据引用无法解析或文本为空）` : "")) +
                (result.body === undefined ? "" : `；正文 ${result.body.sentences} 句` +
                  (result.body.unsupported.length > 0 ? `，${result.body.unsupported.length} 句待补充证据` : "") +
                  (result.body.rejected.length > 0 ? `，${result.body.rejected.length} 句被拒绝（锚点不匹配槽位）` : ""))
              : `导出失败${requested}：${result.reason}`) + excluded,
            data: JSON.stringify(
              result.paths ?? { reason: result.reason, warnings: result.warnings, unanchoredCount: result.unanchoredCount },
            ),
          };
        }
        const result = await service.formatCitations(scope, {
          style: args.style ?? "apa",
          evidenceIds: args.evidenceIds,
          ...(paperIds ? { paperIds } : {}),
        });
        return { action: "citations", text: result.text, data: JSON.stringify(result.entries) };
      },
      presentCall: (args) => ({ card: "generic", title: `Review: ${args.action}`, kind: "read", rawInput: args }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "paper_status",
      description:
        "Report library coverage and indexing state, so claims about the corpus stay honest: how many papers exist, " +
        "how many actually have indexed full text, total pages, evidence count, and available citation styles.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            papers: { type: "integer", required: true },
            withFullText: { type: "integer", required: true },
            pages: { type: "integer", required: true },
            evidence: { type: "integer", required: true },
            // Reported next to evidence but separate from it: a reader who highlights
            // five passages has contributed zero evidence, and a status call that
            // blurred the two would overstate the library's actual support.
            annotations: { type: "integer", required: true },
            styles: { type: "array", required: true, items: { type: "string" } },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `Library: ${value.papers} papers (${value.withFullText} with full text), ${value.pages} indexed pages, ${value.evidence} evidence rows, ${value.annotations} annotations. Styles: ${value.styles.join(", ")}.`,
          },
        ],
      },
      execute: async (_args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        const status = await service.status(scope);
        return {
          papers: status.library.papers,
          withFullText: status.library.withFullText,
          pages: status.library.pages,
          evidence: status.library.evidence,
          annotations: status.library.annotations ?? 0,
          styles: status.styles ?? [],
        };
      },
      presentCall: () => ({ card: "generic", title: "Paper library status", kind: "read", rawInput: {} }),
    }),
  );
}

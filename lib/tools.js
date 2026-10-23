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
        "material=fulltext means the PDF text was indexed; metadata means only bibliographic fields exist.",
      parameters: {
        query: { type: "string", required: true, description: "Keywords. Chinese and English both work." },
        scope: {
          type: "string",
          enum: ["library", "external", "cnki"],
          description: "library (default) | external (OpenAlex/Crossref/arXiv) | cnki (needs a login first)",
        },
        limit: { type: "integer", description: "Max hits (default 20 local / 10 external)." },
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
              return `- ${hit.title}${hit.year ? ` (${hit.year})` : ""} [${hit.source}]${hit.doi ? ` doi:${hit.doi}` : ""}${hit.pdfUrl ? " · PDF available" : ""}`;
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
            titles: { type: "array", required: true, items: { type: "string" } },
            libraryPapers: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `Added ${value.added} paper(s) to the library (now ${value.libraryPapers} total):\n${value.titles.map((title) => `- ${title}`).join("\n")}`,
          },
        ],
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        const result = await service.addCandidates(scope, { candidates: args.candidates });
        return {
          added: result.imported.length,
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
        "Use paper_search first to get a paperId.",
      parameters: {
        paperId: { type: "string", required: true, description: "paperId from paper_search." },
        fromPage: { type: "integer", description: "First page (0-based, default 0)." },
        toPage: { type: "integer", description: "End page exclusive (default fromPage+3)." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", required: true },
            numPages: { type: "integer", required: true },
            material: { type: "string", required: true },
            returned: { type: "integer", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `${value.title} (${value.numPages}p, ${value.material}); returned ${value.returned} page(s):\n\n${value.text}`,
          },
        ],
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        const from = args.fromPage ?? 0;
        const to = args.toPage ?? from + 3;
        const result = await service.readPaper(scope, { paperId: args.paperId, fromPage: from, toPage: to });
        const text = result.pages
          .map((page) => `--- page ${page.pageIndex + 1} ---\n${page.text}`)
          .join("\n\n");
        return {
          title: result.paper.title || result.paper.paperId,
          numPages: result.paper.numPages,
          material: result.paper.material,
          returned: result.coverage.returned,
          text: text.slice(0, 60000),
        };
      },
      presentCall: (args) => ({ card: "generic", title: "Read paper", kind: "read", rawInput: args }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "paper_evidence",
      description:
        "Find cited evidence in the library and record it for a claim. action=collect searches page text and saves " +
        "matching passages as evidence rows; action=list returns saved evidence. Every evidence row carries a paper, " +
        "a page number and the exact quote, so later citations can be traced back.",
      parameters: {
        action: { type: "string", required: true, enum: ["collect", "list"], description: "collect | list" },
        query: { type: "string", description: "Required for action=collect: the passage topic to search." },
        paperId: { type: "string", description: "Optional for collect: restrict to one paper." },
        limit: { type: "integer", description: "Max results (default 10)." },
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
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.count === 0
                ? "No evidence found."
                : `${value.count} evidence row(s):\n${value.evidence
                    .map((row) => `- [${row.evidenceId.slice(0, 8)}] ${row.paperId} p.${row.pageIndex + 1}: "${row.quote.slice(0, 160)}"`)
                    .join("\n")}`,
          },
        ],
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
        const limit = args.limit ?? 10;
        if (args.action === "list") {
          const rows = await service.listEvidence(scope, { paperId: args.paperId, limit });
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
        if (typeof args.query !== "string" || args.query.trim() === "") {
          throw new Error("paper_evidence action=collect requires `query`");
        }
        const collected = await service.collectEvidence(scope, {
          query: args.query,
          paperId: args.paperId,
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
        "Build a traceable review draft from the library. action=outline lists the evidence grouped by paper so you " +
        "can propose structure; action=matrix returns the claim x paper evidence matrix; action=citations formats " +
        "references in the requested CSL style; action=export writes review.md and references.bib into the workspace. " +
        "All output is grounded in stored evidence — never invent citations.",
      parameters: {
        action: { type: "string", required: true, enum: ["outline", "matrix", "citations", "export"], description: "outline | matrix | citations | export" },
        style: { type: "string", description: "For action=citations: CSL style id, e.g. apa, ieee, chicago-author-date." },
        claim: { type: "string", description: "For action=matrix: the claim to check against collected evidence." },
        stance: { type: "string", enum: STANCES, description: "For action=matrix: how the evidence relates to the claim." },
        evidenceIds: { type: "array", items: { type: "string" }, description: "For action=matrix/citations: evidence to include." },
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
        if (args.action === "outline") {
          const result = await service.reviewOutline(scope, {});
          return { action: "outline", text: result.text, data: JSON.stringify(result.groups) };
        }
        if (args.action === "matrix") {
          const result = await service.reviewMatrix(scope, {
            claim: args.claim,
            stance: args.stance,
            evidenceIds: args.evidenceIds,
          });
          return { action: "matrix", text: result.text, data: JSON.stringify(result.rows) };
        }
        if (args.action === "export") {
          const result = await service.exportReview(scope, {
            style: args.style ?? "apa",
            evidenceIds: args.evidenceIds,
          });
          return {
            action: "export",
            text: result.ok
              ? `已导出 ${result.evidenceCount} 条证据（${result.paperCount} 篇论文）到 ${result.paths.dir}`
              : `导出失败：${result.reason}`,
            data: JSON.stringify(result.paths ?? { reason: result.reason, warnings: result.warnings }),
          };
        }
        const result = await service.formatCitations(scope, {
          style: args.style ?? "apa",
          evidenceIds: args.evidenceIds,
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
            styles: { type: "array", required: true, items: { type: "string" } },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `Library: ${value.papers} papers (${value.withFullText} with full text), ${value.pages} indexed pages, ${value.evidence} evidence rows. Styles: ${value.styles.join(", ")}.`,
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
          styles: status.styles ?? [],
        };
      },
      presentCall: () => ({ card: "generic", title: "Paper library status", kind: "read", rawInput: {} }),
    }),
  );
}

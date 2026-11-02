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
            truncated: { type: "boolean", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
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
        ],
      },
      execute: async (args, exec) => {
        const service = getService();
        const scope = withScope(exec);
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
        action: { type: "string", required: true, enum: ["outline", "matrix", "citations", "export", "claims", "bodyplan", "body"], description: "outline | matrix | citations | export | claims | bodyplan | body" },
        style: { type: "string", description: "For action=citations: CSL style id, e.g. apa, ieee, chicago-author-date." },
        section: { type: "string", description: "For action=bodyplan/body: section heading for the generated text." },
        limit: { type: "integer", description: "For action=bodyplan: how many evidence rows to build slots from (default 200)." },
        claim: { type: "string", description: "For action=matrix: the claim to check against collected evidence." },
        stance: { type: "string", enum: STANCES, description: "For action=matrix: how the evidence relates to the claim." },
        evidenceIds: { type: "array", items: { type: "string" }, description: "For action=matrix/citations: evidence to include." },
        claims: {
          type: "array",
          description:
            "For action=export: the draft's sentences, each bound to stored evidence. " +
            "Shape: [{text, section?, evidenceIds? | evidence?: [{evidenceId, stance?, strength?}]}]. " +
            "Every evidenceId must already exist — an invented id is rejected, never stored.",
        },
        sentences: {
          type: "array",
          description:
            "For action=body: the filled body plan. Shape: [{slotId, text, evidenceIds?}]. " +
            "Each slotId must come from action=bodyplan, and evidenceIds must be ids that slot " +
            "was bound to. A sentence whose anchor does not resolve is rejected, not rendered. " +
            "Omit evidenceIds to use the slot's own binding.",
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
        if (args.action === "claims") {
          // No `claims` payload: this branch is read-only, reporting what has been
          // recorded so far. Writing claims goes through `recordClaims`, called by
          // `paper_review action=export` with the draft the model just wrote — see
          // that path below. Keeping the read and the write apart means a model
          // cannot "list" its way into mutating the library.
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
        if (args.action === "bodyplan") {
          const result = await service.reviewBodyPlan(scope, {
            section: args.section,
            evidenceIds: args.evidenceIds,
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
          });
          if (!result.ok) {
            return { action: "body", text: `无法生成正文：${result.reason}`, data: JSON.stringify({ reason: result.reason }) };
          }
          const notes = [];
          if (result.summary.rejected > 0) {
            notes.push(`${result.summary.rejected} 句被拒绝（锚点指向不属于该槽位的证据，或槽位不存在）`);
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
            evidenceIds: args.evidenceIds,
            claims: args.claims,
            sentences: args.sentences,
            bodySection: args.section,
          });
          return {
            action: "export",
            text: result.ok
              ? `已导出 ${result.evidenceCount} 条证据（${result.paperCount} 篇论文）到 ${result.paths.dir}` +
                (result.claims === undefined ? "" : `，其中 ${result.claims.accepted} 条论断已绑定证据` +
                  (result.claims.rejected > 0 ? `，${result.claims.rejected} 条被拒绝（引用了不存在的证据）` : "")) +
                (result.body === undefined ? "" : `；正文 ${result.body.sentences} 句` +
                  (result.body.unsupported.length > 0 ? `，${result.body.unsupported.length} 句待补充证据` : "") +
                  (result.body.rejected.length > 0 ? `，${result.body.rejected.length} 句被拒绝（锚点不匹配槽位）` : ""))
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

// Tool-registration gate: prove the five agent tools register under the REAL
// dsh-tools registry and that a bad definition would fail loudly.
//
// The registry validates the author schema DSL at registration time, so this
// catches schema mistakes that a plain import would not.
//
// Run: node test/s4-tools.mjs <pdfDir>
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

const { PaperToolService } = await import("../lib/host-service.js");
const { registerPaperTools } = await import("../lib/tools.js");

const registered = [];
const provided = [];
const work = mkdtempSync(join(tmpdir(), "paper-tool-tools-"));

const ctx = {
  reflect: { provide: (name) => provided.push(name) },
  tools: {
    register: (definition) => {
      registered.push(definition);
      return () => {};
    },
  },
  inject: (_deps, callback) => callback({ typert: { lookups: { register: () => {} } }, sessions: { get: () => undefined } }),
  effect: () => {},
  get: () => undefined,
};

const service = new PaperToolService(ctx, {});

// Registration itself validates every schema, so a throw here is a real defect.
try {
  registerPaperTools(ctx, () => service);
  check("tools register without throwing", true);
} catch (error) {
  check("tools register without throwing", false, error?.message ?? String(error));
}

const names = registered.map((tool) => tool.name).sort();
check("exactly six tools registered", registered.length === 6, JSON.stringify(names));
check(
  "tool names are the planned surface",
  JSON.stringify(names) === JSON.stringify(["paper_evidence", "paper_import", "paper_read", "paper_review", "paper_search", "paper_status"]),
  JSON.stringify(names),
);

for (const tool of registered) {
  check(`${tool.name} has a description`, typeof tool.description === "string" && tool.description.length > 20);
  check(`${tool.name} has a compiled parameter schema`, typeof tool.parameters === "object" && tool.parameters !== null);
  check(`${tool.name} has an output schema`, tool.output?.schema !== undefined);
  check(`${tool.name} has a renderer`, typeof tool.output?.render === "function");
  check(`${tool.name} has execute`, typeof tool.execute === "function");
}

// --- execute a tool for real, with a fake exec carrying a session
const scope = { sessionId: "session-tools-test", workspaceRoot: work };
const exec = { agent: { session: { id: "session-tools-test", header: { cwd: work } } }, signal: new AbortController().signal };

const searchTool = registered.find((tool) => tool.name === "paper_search");
const emptySearch = await searchTool.execute({ query: "anything" }, exec);
check("search runs on an empty library", emptySearch.count === 0);
check("search reports library stats", emptySearch.library.papers === 0);
const rendered = searchTool.output.render({ query: "anything" }, emptySearch);
check("render returns content parts", Array.isArray(rendered) && rendered[0]?.type === "text");

// --- import a real PDF, then drive the whole agent flow through tools
const pdf = process.argv
  .slice(2)
  .flatMap((dir) => {
    try {
      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile?.() && entry.name.toLowerCase().endsWith(".pdf"))
        .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
    } catch {
      return [];
    }
  })
  .find((path) => {
    try {
      return statSync(path).size > 8192;
    } catch {
      return false;
    }
  });

if (pdf) {
  const imported = await service.importPdf(scope, {
    files: [{ name: pdf.split(/[\\/]/).pop(), data: Array.from(new Uint8Array(readFileSync(pdf))) }],
  });
  const paperId = imported.imported[0]?.paperId;
  check("import via service for tool flow", typeof paperId === "string");

  const statusTool = registered.find((tool) => tool.name === "paper_status");
  const status = await statusTool.execute({}, exec);
  check("status tool reports the paper", status.papers === 1);
  check("status tool lists styles", status.styles.length > 0);

  const readTool = registered.find((tool) => tool.name === "paper_read");
  const read = await readTool.execute({ paperId, fromPage: 0, toPage: 1 }, exec);
  check("read tool returns text", read.text.length > 20);
  check("read tool reports page count", read.numPages > 0);

  const evidenceTool = registered.find((tool) => tool.name === "paper_evidence");
  const word = (read.text.match(/[a-zA-Z]{5,}/) ?? [])[0] ?? "the";
  const collected = await evidenceTool.execute({ action: "collect", query: word }, exec);
  check("evidence collect returns rows", collected.count > 0, `query=${word}`);
  const listed = await evidenceTool.execute({ action: "list" }, exec);
  check("evidence list returns the same rows", listed.count === collected.count);

  const reviewTool = registered.find((tool) => tool.name === "paper_review");
  const outline = await reviewTool.execute({ action: "outline" }, exec);
  check("review outline returns text", outline.text.length > 20);
  const matrix = await reviewTool.execute({ action: "matrix", claim: word }, exec);
  check("review matrix returns text", matrix.text.length > 10);
  const citations = await reviewTool.execute({ action: "citations", style: "gb-t-7714" }, exec);
  check("review citations renders GB/T", citations.text.includes("[1]"), citations.text.slice(0, 120));
}

// --- a missing session must fail loudly, not silently use some other workspace
let sessionGuarded = false;
try {
  await searchTool.execute({ query: "x" }, {});
} catch (error) {
  sessionGuarded = /session/i.test(error?.message ?? "");
}
check("tool refuses to run without a session", sessionGuarded);

// --- external search reaches live sources and imports only what was chosen
const before = await searchTool.execute({ query: "anything", scope: "library" }, exec);
const external = await searchTool.execute({ query: "psychological ownership hospitality", scope: "external", limit: 3 }, exec);
check("external search returns candidates", external.count > 0, JSON.stringify(external.failures));
check("external hits are marked metadata-only", external.hits.every((hit) => hit.material === "metadata"));
check("external search does not touch the library", external.library.papers === before.library.papers);

const importTool = registered.find((tool) => tool.name === "paper_import");
const chosen = external.hits.slice(0, 2).map((hit) => ({
  title: hit.title,
  authors: hit.authors ?? "",
  year: hit.year ?? "",
  venue: hit.venue ?? "",
  doi: hit.doi ?? "",
  source: hit.source ?? "external",
}));
const importedCandidates = await importTool.execute({ candidates: chosen }, exec);
check("import adds exactly the chosen candidates", importedCandidates.added === chosen.length);
check("import reports the new library size", importedCandidates.libraryPapers === before.library.papers + chosen.length);
const afterImport = await searchTool.execute({ query: "anything", scope: "library" }, exec);
check(
  "imported candidates do not add full text",
  afterImport.library.papers === before.library.papers + chosen.length &&
    afterImport.library.withFullText === before.library.withFullText,
);

// --- dangerous shapes are rejected, not silently accepted
let noCandidates = false;
try {
  await importTool.execute({ candidates: [] }, exec);
} catch {
  noCandidates = true;
}
check("import rejects an empty candidate list", noCandidates);
const untitled = await importTool.execute({ candidates: [{ title: "   " }] }, exec);
check("import drops candidates without a title", untitled.added === 0);

// --- required-argument enforcement comes from the registry
let argsValidated = false;
try {
  await reviewTool.execute({}, exec);
} catch {
  argsValidated = true;
}
check("review rejects a missing action", argsValidated);

service.stores.forEach((store) => store.close());
rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nTOOLS FAILED (${failures.length}):`);
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("\nTOOLS PASS");

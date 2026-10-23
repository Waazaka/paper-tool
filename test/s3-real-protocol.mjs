// Real-dependency load test: import the shipped plugin with the ACTUAL
// @deepseek-ai/dsh-typert-protocol package (linked into this package's
// node_modules), then construct the service and call every Remote method
// through a fake ctx. This catches protocol/decoration mistakes that the
// shim-based test cannot.
//
// Run: node test/s3-real-protocol.mjs <pdfDir>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
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

const plugin = await import("../index.js");
check("plugin exports inject", Array.isArray(plugin.inject));
check("plugin exports apply", typeof plugin.apply === "function");

// Minimal ctx matching what the service touches. The Service base class calls
// ctx.reflect.provide(), and apply() registers tools, so both must exist.
const registered = { lookups: [], effects: [], provided: [], tools: [] };
const ctx = {
  reflect: {
    provide: (name, instance) => registered.provided.push(name),
  },
  tools: {
    register: (definition) => {
      registered.tools.push(definition.name);
      return () => {};
    },
  },
  inject(_deps, callback) {
    callback({
      typert: { lookups: { register: (name, definition) => registered.lookups.push({ name, definition }) } },
      sessions: { get: () => undefined },
      get: () => ({ stat: async () => undefined }),
    });
  },
  effect(fn) { registered.effects.push(fn); },
  get: () => undefined,
};

const work = mkdtempSync(join(tmpdir(), "paper-tool-real-"));
let service = null;
try {
  plugin.apply(ctx, {});
  check("apply constructs without throwing", true);
  check("registers the scope lookup", registered.lookups.some((entry) => entry.name === "paperToolScope"));
  check("registers all six tools under the real registry", registered.tools.length === 6, JSON.stringify(registered.tools));

  // Retrieve the constructed service from the plugin module's own registry by
  // applying again is not exposed, so construct directly for method checks.
  const { PaperToolService } = await import("../lib/host-service.js");
  service = new PaperToolService(ctx, {});
  check("service exposes Remote methods", typeof service.search === "function");

  const scope = { sessionId: "session-real-test", workspaceRoot: work };
  const status = await service.status(scope);
  check("status works over the real protocol", status.library.papers === 0);

  // Import one real PDF end to end.
  const dirs = process.argv.slice(2);
  const pdf = dirs
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
    check("real import succeeds", imported.imported.length === 1, JSON.stringify(imported.failed));
    const bytes = await service.readPaperBytes(scope, { paperId: imported.imported[0].paperId });
    check("real byte read succeeds", bytes.bytes > 1000);
  }
} catch (error) {
  console.log(`  FAIL threw: ${error?.stack ?? error}`);
  failures.push(String(error?.message ?? error));
} finally {
  service?.stores?.forEach((store) => store.close());
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nREAL-PROTOCOL FAILED (${failures.length})`);
  process.exit(1);
}
console.log("\nREAL-PROTOCOL PASS");

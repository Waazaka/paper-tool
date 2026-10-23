// Test shim: load the real Host service source with the DSH protocol package
// replaced by local stand-ins.
//
// Reason: `@deepseek-ai/dsh-typert-protocol` only exists inside a DSH profile.
// The service class itself is ordinary JavaScript, so its two imports are
// rewritten to a shim and the result is imported. Generated files live inside
// this package (under .shim/) so that bare specifiers like `pdfjs-dist` still
// resolve against the package's own node_modules.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, "..", "lib");
const outDir = join(here, ".shim");

const SHIM = `
export class RemoteError extends Error {
  constructor(code, message, detail) {
    super(message ?? code);
    this.code = code;
    this.detail = detail;
  }
}
export class TypertRemoteService {
  constructor(ctx, key) { this.ctx = ctx; this.serviceKey = key; }
}
export function Remote() { return () => {}; }
`;

function rewrite(source, shimUrl, targetDir) {
  return source
    .replace(
      /from "@deepseek-ai\/dsh-typert-protocol"/g,
      `from ${JSON.stringify(shimUrl)}`,
    )
    // Only rewrite sibling relative imports to the generated copies; anything
    // already generated must point back into the real lib directory.
    .replace(/from "\.\/([a-z-]+\.js)"/g, (_all, file) => `from ${JSON.stringify(join(targetDir, file).replace(/\\/g, "/"))}`);
}

export async function loadService() {
  await mkdir(outDir, { recursive: true });
  const shimPath = join(outDir, "protocol-shim.mjs");
  await writeFile(shimPath, SHIM, "utf8");
  const shimUrl = pathToFileURL(shimPath).href;

  // Generate every sibling module automatically: a hand-maintained list goes
  // stale the moment a new lib file is added, and the failure looks like a
  // missing module rather than a test-fixture gap.
  const libFiles = await readdir(libDir);
  for (const name of libFiles.filter((file) => file.endsWith(".js"))) {
    const source = await readFile(join(libDir, name), "utf8");
    const patched = source.replace(
      /from "@deepseek-ai\/dsh-typert-protocol"/g,
      `from ${JSON.stringify(shimUrl)}`,
    ).replace(
      /from "\.\/([a-z-]+\.js)"/g,
      (_all, file) => `from ${JSON.stringify(pathToFileURL(join(libDir, file)).href)}`,
    );
    await writeFile(join(outDir, name), patched, "utf8");
  }

  const serviceSource = await readFile(join(libDir, "host-service.js"), "utf8");
  const patched = serviceSource
    .replace(/from "@deepseek-ai\/dsh-typert-protocol"/g, `from ${JSON.stringify(shimUrl)}`)
    .replace(
      /from "\.\/([a-z-]+\.js)"/g,
      (_all, file) => `from ${JSON.stringify(pathToFileURL(join(outDir, file)).href)}`,
    );
  const servicePath = join(outDir, "service-under-test.mjs");
  await writeFile(servicePath, patched, "utf8");

  return await import(pathToFileURL(servicePath).href);
}

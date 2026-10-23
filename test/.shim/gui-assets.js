// Host-side reader for this package's OWN pdfjs runtime only.
//
// The browser client cannot load non-baseline modules (dsh-client-modules
// serves only registered client bundles), so the sidebar reader needs the
// pdfjs build to cross the authenticated RPC boundary. This reader exposes
// exactly the two files inside this package's own pdfjs-dist install. No
// client-supplied path is ever accepted.
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { RemoteError } from "file:///D:/dhs/%E7%9F%A5%E8%AF%86%E5%BA%93%E6%8F%92%E4%BB%B6/packages/paper-tool/test/.shim/protocol-shim.mjs";

/**
 * Resolve the package's own pdfjs build by module resolution rather than by a
 * path relative to this file: the module may be loaded from a generated copy
 * (tests) or the installed bundle, and only resolution finds node_modules in
 * both cases.
 */
function pdfjsFiles() {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  return {
    main: join(root, "build", "pdf.mjs"),
    worker: join(root, "build", "pdf.worker.mjs"),
  };
}

async function readBounded(path, cap, signal) {
  const info = await stat(path);
  if (!info.isFile()) throw new RemoteError("paper-tool/asset-missing", `${path} is not a file`);
  if (info.size > cap) {
    throw new RemoteError("paper-tool/too-large", `${path} exceeds the ${cap} byte asset cap`, { limit: cap });
  }
  signal?.throwIfAborted();
  const buffer = await readFile(path);
  signal?.throwIfAborted();
  return { buffer, bytes: info.size };
}

/**
 * Read one asset file from this package's pdfjs install.
 *
 * The browser reader needs CMaps to render CJK glyphs (without them Chinese
 * pages come out as blank or garbled), and those files are too many to ship in
 * one response, so they are fetched one at a time.
 */
export async function readPdfjsAsset(kind, name, signal) {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const allowed = { cmaps: "cmaps", standard_fonts: "standard_fonts" };
  const dirName = allowed[kind];
  if (dirName === undefined) {
    throw new RemoteError("paper-tool/bad-asset-kind", `unknown asset kind: ${kind}`);
  }
  // Reject traversal before touching the filesystem: `name` arrives from the
  // browser and must be a bare filename inside the known directory.
  if (typeof name !== "string" || name === "" || /[\\/]/.test(name) || name.includes("..")) {
    throw new RemoteError("paper-tool/bad-asset-name", "asset name must be a bare filename");
  }
  // pdfjs asks for a CMap by bare name ("UniGB-UCS2-H") while the files carry
  // a .bcmap suffix, so the suffix is added here rather than in the caller.
  const baseDir = join(root, dirName);
  const candidates =
    kind === "cmaps" && !name.endsWith(".bcmap") ? [`${name}.bcmap`, name] : [name];
  let file = null;
  for (const candidate of candidates) {
    try {
      const info = await stat(join(baseDir, candidate));
      if (info.isFile()) {
        file = join(baseDir, candidate);
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (file === null) {
    throw new RemoteError("paper-tool/asset-missing", `${kind}/${name} not found`);
  }
  const info = await stat(file);
  if (info.size > 4 * 1024 * 1024) {
    throw new RemoteError("paper-tool/too-large", `${name} exceeds the asset cap`);
  }
  signal?.throwIfAborted();
  const buffer = await readFile(file);
  return { name, bytes: info.size, data: new Uint8Array(buffer) };
}

export async function readPdfjsRuntime(signal) {
  const files = pdfjsFiles();
  const [main, worker] = await Promise.all([
    readBounded(files.main, 12 * 1024 * 1024, signal),
    readBounded(files.worker, 12 * 1024 * 1024, signal),
  ]);
  return {
    source: "@local/paper-tool/pdfjs-dist",
    pdfMainSource: main.buffer.toString("utf8"),
    pdfWorkerSource: worker.buffer.toString("utf8"),
    bytes: { pdfMain: main.bytes, pdfWorker: worker.bytes },
  };
}

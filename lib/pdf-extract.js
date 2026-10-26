// PDF text extraction (S1) using pdfjs-dist — a pure-JS dependency that also
// powers the S2 reader, so one library serves parsing and rendering.
//
// Extraction is per page: the S1 store keeps page-local text so every later
// evidence anchor can name a physical page.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { guessMetadata as guessMetadataFull, layoutLines, readXmp } from "./pdf-metadata.js";

let pdfjsPromise = null;

/**
 * Absolute path to pdfjs-dist's bundled CMap tables. Without these, CJK PDFs
 * decode to punctuation only — verified against a real Chinese paper, so this
 * is required, not optional.
 */
function cmapPaths() {
  const require = createRequire(import.meta.url);
  let root;
  try {
    root = dirname(require.resolve("pdfjs-dist/package.json"));
  } catch {
    return null;
  }
  return {
    cMapUrl: join(root, "cmaps") + "/",
    standardFontDataUrl: join(root, "standard_fonts") + "/",
  };
}

async function loadPdfjs() {
  if (pdfjsPromise === null) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => import("pdfjs-dist"));
  }
  return await pdfjsPromise;
}

/**
 * Extract per-page text from a PDF byte buffer.
 * @param {Uint8Array} data
 * @returns {Promise<{pages: string[], numPages: number, fingerprint: string}>}
 */
export async function extractPdfPages(data) {
  // pdf.js rejects Buffer specifically, so always hand it a plain Uint8Array
  // that is a copy (Buffer#buffer may be a shared pool).
  const bytes =
    ArrayBuffer.isView(data) && !(data instanceof Uint8Array)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
  const fingerprint = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const pdfjs = await loadPdfjs();
  const cmaps = cmapPaths();
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useWorkerFetch: false,
    cMapPacked: true,
    enableXfa: false,
    stopAtErrors: false,
    // Node has no worker; run on the current thread.
    disableWorker: true,
    ...(cmaps ?? {}),
  }).promise;

  const pages = [];
  let info = {};
  let xmp = {};
  let layout = [];
  try {
    // The document's own metadata is far better than anything guessable from
    // prose: publishers write dc:title and dc:creator, and Zotero/CNKI leave the
    // citation in Info.Subject. Read it before the text loop so a page that fails
    // to render still contributes its metadata.
    try {
      const metadata = await doc.getMetadata();
      info = metadata?.info ?? {};
      if (metadata?.metadata !== null && typeof metadata?.metadata?.get === "function") {
        xmp = readXmp(metadata.metadata);
      }
    } catch {
      // Metadata is optional; a malformed packet must not fail the import.
    }
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        pages.push(itemsToText(content.items));
        // Page 1's type sizes are the only reliable title signal on CJK PDFs.
        if (pageNumber === 1) layout = layoutLines(content.items);
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.loadingTask?.destroy?.();
  }
  return { pages, numPages: doc.numPages, fingerprint, info, xmp, layout };
}

/**
 * Join text items into lines. pdf.js emits items in content order; a large
 * vertical gap (`hasEOL`, or a y jump) starts a new line so downstream snippet
 * extraction does not glue a heading onto the following paragraph.
 */
function itemsToText(items) {
  const parts = [];
  let lastY = null;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (lastY !== null && typeof item.transform?.[5] === "number") {
      if (Math.abs(item.transform[5] - lastY) > 2) parts.push("\n");
    }
    parts.push(item.str);
    if (item.hasEOL) parts.push("\n");
    if (typeof item.transform?.[5] === "number") lastY = item.transform[5];
  }
  return parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Heuristic metadata recovery.
 *
 * Delegates to `pdf-metadata.js`, which layers XMP → Info → Subject → file name →
 * page-1 type size. The old version read page-1's first line and first four-digit
 * number; over 32 real papers that produced authors 0/32, venue 0/32 and a wrong
 * title on 10/32.
 *
 * @param {string[]} pages
 * @param {{info?: object, xmp?: object, layout?: object[], filename?: string}} [extra]
 */
export function guessMetadata(pages, extra = {}) {
  return guessMetadataFull(pages, extra);
}

// PDF text extraction (S1) using pdfjs-dist — a pure-JS dependency that also
// powers the S2 reader, so one library serves parsing and rendering.
//
// Extraction is per page: the S1 store keeps page-local text so every later
// evidence anchor can name a physical page.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        pages.push(itemsToText(content.items));
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.loadingTask?.destroy?.();
  }
  return { pages, numPages: doc.numPages, fingerprint };
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
 * Heuristic metadata guess from page-1 text. Deliberately shallow: the caller
 * can override any field, and the model fills gaps later.
 */
export function guessMetadata(pages) {
  const first = pages[0] ?? "";
  const lines = first.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = lines[0] ?? "";
  const yearMatch = first.match(/\b(19|20)\d{2}\b/);
  const doiMatch = first.match(/10\.\d{4,9}\/[^\s"'<>]+/);
  return {
    title: title.slice(0, 300),
    year: yearMatch ? yearMatch[0] : "",
    doi: doiMatch ? doiMatch[0].replace(/[.,;]$/, "") : "",
  };
}

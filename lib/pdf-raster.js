// Page rasterization for OCR.
//
// A scanned PDF has no text layer, so `extractPdfPages` returns "" for every
// page and the paper becomes metadata-only. To recover text we must draw the
// page to a bitmap and hand that to an OCR engine.
//
// Rendering uses pdf.js with a real canvas backend. Two things make this work
// in Node and both are easy to get wrong:
//
//   1. pdf.js draws text and paths through DOM globals (`Path2D`, `DOMMatrix`,
//      `ImageData`, ...). Without installing them the render dies with
//      "Path2D is not defined" partway through the first page.
//   2. pdf.js resolves its canvas backend by the bare specifier
//      "@napi-rs/canvas" from inside its own package, so the dependency must be
//      a real, resolvable dependency of this package rather than only present
//      in the pnpm store.
//
// Failures here are reported, never swallowed: a caller must be able to tell
// "this page has no text" from "we could not read this page".
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let pdfjsPromise = null;
let canvasPromise = null;

async function loadPdfjs() {
  if (pdfjsPromise === null) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => import("pdfjs-dist"));
  }
  return await pdfjsPromise;
}

/**
 * Load the native canvas backend and publish the DOM globals pdf.js expects.
 *
 * Returns null when the backend is missing (an install without the optional
 * native binary); callers treat that as "rasterization unavailable" rather than
 * crashing the import path.
 */
async function loadCanvas() {
  if (canvasPromise === null) {
    canvasPromise = (async () => {
      let mod;
      try {
        mod = await import("@napi-rs/canvas");
      } catch {
        return null;
      }
      for (const name of ["Path2D", "DOMMatrix", "DOMPoint", "DOMRect", "ImageData", "Image"]) {
        if (globalThis[name] === undefined && mod[name] !== undefined) globalThis[name] = mod[name];
      }
      return mod;
    })();
  }
  return await canvasPromise;
}

/** Whether page rasterization is possible in this process. */
export async function rasterizerAvailable() {
  try {
    const [canvas, pdfjs] = await Promise.all([loadCanvas(), loadPdfjs()]);
    return canvas !== null && typeof pdfjs?.getDocument === "function";
  } catch {
    return false;
  }
}

function cmapPaths() {
  try {
    const root = require("pdfjs-dist/package.json");
    const dir = root.slice(0, root.lastIndexOf("package.json"));
    return {
      cMapUrl: `${dir.replaceAll("\\", "/")}cmaps/`,
      standardFontDataUrl: `${dir.replaceAll("\\", "/")}standard_fonts/`,
    };
  } catch {
    return null;
  }
}

/**
 * Longest side the Windows OCR engine will decode.
 *
 * `OcrEngine.MaxImageDimension` is 10000 on this machine, and a page rendered
 * beyond it does not degrade — recognition throws "Image dimensions are too
 * large" and yields no text at all. A large-format page (A3 at a high scale, or
 * a whole sheet scanned at 600 dpi) reaches that, so the rasterizer keeps every
 * page inside the limit rather than letting OCR fail opaquely.
 */
const MAX_OCR_EDGE = 10000;

/**
 * Render selected pages to PNG buffers.
 *
 * The default scale is 2.0: measured against a real Chinese scan, 1.0 lost small
 * glyphs while 4.0 only grew the runtime. Pages are rendered one at a time and
 * released immediately so a 50-page scan does not hold 50 bitmaps at once.
 *
 * @param {Uint8Array} data PDF bytes
 * @param {{scale?: number, pages?: number[], maxEdge?: number}} [options]
 * @returns {Promise<{pages: {pageIndex: number, png: Buffer}[], numPages: number}>}
 */
export async function rasterizePdfPages(data, options = {}) {
  const canvasMod = await loadCanvas();
  if (canvasMod === null) {
    throw new Error("rasterizePdfPages: canvas backend unavailable (@napi-rs/canvas not installed)");
  }
  const pdfjs = await loadPdfjs();
  const requestedScale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 2;
  const maxEdge = Number.isFinite(options.maxEdge) && options.maxEdge > 0 ? options.maxEdge : MAX_OCR_EDGE;
  const wanted = Array.isArray(options.pages) ? new Set(options.pages) : null;
  // Always copy. pdf.js takes ownership of the buffer it is given and detaches
  // it; a view over the caller's bytes (`new Uint8Array(data.buffer, ...)`) would
  // therefore destroy the caller's buffer, and the import path reuses those bytes
  // afterwards to save the PDF. That failure reads as "Cannot perform Construct
  // on a detached ArrayBuffer" and made every scanned import fail.
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
  const cmaps = cmapPaths();
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useWorkerFetch: false,
    cMapPacked: true,
    enableXfa: false,
    stopAtErrors: false,
    disableWorker: true,
    ...(cmaps ?? {}),
  }).promise;

  const out = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const pageIndex = pageNumber - 1;
      if (wanted !== null && !wanted.has(pageIndex)) continue;
      const page = await doc.getPage(pageNumber);
      try {
        // Clamp per page: a PDF can mix page sizes, so the scale that fits one
        // page may overflow the next.
        const base = page.getViewport({ scale: requestedScale });
        const longest = Math.max(base.width, base.height);
        const scale = longest > maxEdge ? (requestedScale * maxEdge) / longest : requestedScale;
        const viewport = page.getViewport({ scale });
        const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        // Paint white first: a transparent PNG reaches OCR as black-on-black.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport, canvas }).promise;
        out.push({ pageIndex, png: canvas.toBuffer("image/png"), width: canvas.width, height: canvas.height, scale });
        // Free the native bitmap now; 50 pages of A4 at scale 2 is ~1 GB.
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.loadingTask?.destroy?.();
  }
  return { pages: out, numPages: doc.numPages };
}

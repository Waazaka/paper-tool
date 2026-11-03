/**
 * Split page text into translation segments.
 *
 * This exists so the Agent never has to guess where paragraphs are. The plugin
 * cannot translate (D-014: no model channel), so its whole contribution to the
 * translation feature is preparation and write-back: cut the page into pieces that
 * are small enough to translate and precise enough to point back at, then store
 * what comes back against those coordinates.
 *
 * Why a segment carries character offsets rather than just its text: the
 * side-by-side view has to put the translation next to the paragraph it belongs to,
 * and the only stable way to say "this paragraph" is where it starts and ends in the
 * page. Recomputed boundaries would drift the moment anything changed how the page
 * text is produced.
 *
 * Two rules that are deliberate rather than incidental:
 *
 *   1. Whitespace around a segment is NOT part of the segment. The offsets name the
 *      actual words, so a caller can re-read the original from the page and get
 *      exactly the same string back.
 *   2. A blank line is the paragraph boundary, but a segment is also capped by
 *      length, because a page with no blank lines (common in CJK PDFs, which often
 *      have no inter-paragraph spacing at all) would otherwise be one enormous
 *      segment that no translator can handle in one piece.
 */

/** Paragraph separators: a blank line, or a run of two or more newlines. */
const PARAGRAPH_BREAK = /\n\s*\n+/;

/**
 * Upper bound on one segment, in characters.
 *
 * Chosen to keep a segment under what a model handles comfortably in one go while
 * still being a real paragraph. CJK characters carry more meaning per character
 * than Latin ones, so the same count is a larger unit there; that is acceptable
 * because the failure mode of an over-long segment is truncation, and the failure
 * mode of an over-short one is a translation with no context.
 */
const MAX_SEGMENT_CHARS = 1200;

/**
 * Split one page's text into segments with exact character offsets.
 *
 * Returns `[{ segmentId, pageIndex, charStart, charEnd, text }]`. Offsets are into
 * the page text as given, so `pageText.slice(charStart, charEnd) === segment.text`.
 *
 * Adjacent short paragraphs are NOT merged: the boundary is what keeps the
 * side-by-side view aligned one-to-one with the original, and merging would make
 * "this paragraph" ambiguous.
 *
 * @param {string} pageText
 * @param {number} pageIndex
 * @param {{ maxChars?: number }} [options]
 * @returns {Array<{segmentId: string, pageIndex: number, charStart: number, charEnd: number, text: string}>}
 */
export function splitPageSegments(pageText, pageIndex, options = {}) {
  const text = typeof pageText === "string" ? pageText : "";
  const page = Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : 0;
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : MAX_SEGMENT_CHARS;
  if (text.trim() === "") return [];

  const segments = [];
  // Walk the original string by index rather than splitting on a regex: split()
  // loses the offsets, and recovering them with indexOf is wrong as soon as two
  // paragraphs have identical text.
  let cursor = 0;
  const push = (start, end) => {
    // Trim whitespace off the edges while keeping the offsets pointing at the
    // words. A caller that re-reads the page by these offsets must get the same
    // string that was sent for translation.
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from])) from += 1;
    while (to > from && /\s/.test(text[to - 1])) to -= 1;
    if (to <= from) return;
    segments.push({
      segmentId: `p${page}-${from}-${to}`,
      pageIndex: page,
      charStart: from,
      charEnd: to,
      text: text.slice(from, to),
    });
  };

  for (const match of text.matchAll(new RegExp(PARAGRAPH_BREAK.source, "g"))) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, text.length);

  // Cap any paragraph that came back too long, splitting on sentence ends when one
  // exists and on a hard character boundary otherwise. Sentence-aware splitting is
  // preferred because a translation of half a sentence reads worse than a slightly
  // long paragraph.
  const capped = [];
  for (const segment of segments) {
    if (segment.text.length <= maxChars) {
      capped.push(segment);
      continue;
    }
    let offset = 0;
    while (offset < segment.text.length) {
      const remaining = segment.text.length - offset;
      if (remaining <= maxChars) {
        capped.push(sliceSegment(segment, offset, segment.text.length));
        break;
      }
      const window = segment.text.slice(offset, offset + maxChars);
      // Prefer a sentence terminator near the end of the window, then a comma or
      // space, then the hard cut.
      let cut = lastIndexAny(window, ["。", "！", "？", ". ", "! ", "? ", "；", "; "]);
      if (cut <= 0) cut = lastIndexAny(window, ["，", ", ", " "]);
      if (cut <= 0) cut = window.length;
      capped.push(sliceSegment(segment, offset, offset + cut));
      offset += cut;
      while (offset < segment.text.length && /\s/.test(segment.text[offset])) offset += 1;
    }
  }
  return capped.filter((segment) => segment.text.trim() !== "");
}

/** Index just past the last occurrence of any needle, or -1. */
function lastIndexAny(haystack, needles) {
  let best = -1;
  for (const needle of needles) {
    const at = haystack.lastIndexOf(needle);
    if (at >= 0) {
      // Step past the needle so the terminator stays with the sentence it ends.
      const end = at + needle.length;
      if (end > best) best = end;
    }
  }
  return best;
}

/** A capped piece of an existing segment, with offsets rebased into the page. */
function sliceSegment(segment, from, to) {
  let start = from;
  let end = to;
  const raw = segment.text;
  while (start < end && /\s/.test(raw[start])) start += 1;
  while (end > start && /\s/.test(raw[end - 1])) end -= 1;
  return {
    segmentId: `p${segment.pageIndex}-${segment.charStart + start}-${segment.charStart + end}`,
    pageIndex: segment.pageIndex,
    charStart: segment.charStart + start,
    charEnd: segment.charStart + end,
    text: raw.slice(start, end),
  };
}

/**
 * Pair source segments with translations, one-to-one.
 *
 * Returns `{ pairs, unmatchedSource, unmatchedTranslation }`. The pairing is by
 * anchor, not by position: a translation is matched to the source segment whose
 * offsets are identical, so a segment that was never translated stays visibly
 * untranslated instead of being paired with the next translation along.
 *
 * This is the check behind "两列条数相等". Returning the two unmatched lists makes
 * a caller able to say *which* paragraph is missing rather than only that the counts
 * differ.
 *
 * @param {Array<{pageIndex: number, charStart: number, charEnd: number, text: string}>} sources
 * @param {Array<{pageIndex: number, charStart: number, charEnd: number, text: string, targetLang?: string}>} translations
 * @param {{ targetLang?: string }} [options]
 * @returns {{
 *   pairs: Array<{source: object, translation: object|null}>,
 *   unmatchedSource: Array<object>,
 *   unmatchedTranslation: Array<object>,
 *   aligned: boolean,
 * }}
 */
export function alignSegments(sources, translations, options = {}) {
  const targetLang = options.targetLang;
  const sourceList = Array.isArray(sources) ? sources : [];
  const translationList = (Array.isArray(translations) ? translations : []).filter(
    (row) => targetLang === undefined || targetLang === null || row.targetLang === undefined || row.targetLang === targetLang,
  );
  const key = (row) => `${row.pageIndex}:${row.charStart}:${row.charEnd}`;
  const byKey = new Map();
  for (const row of translationList) byKey.set(key(row), row);

  const pairs = [];
  const unmatchedSource = [];
  const usedKeys = new Set();
  for (const source of sourceList) {
    const found = byKey.get(key(source));
    if (found === undefined) {
      unmatchedSource.push(source);
      pairs.push({ source, translation: null });
      continue;
    }
    usedKeys.add(key(source));
    pairs.push({ source, translation: found });
  }
  const unmatchedTranslation = translationList.filter((row) => !usedKeys.has(key(row)));
  return {
    pairs,
    unmatchedSource,
    unmatchedTranslation,
    // Aligned means every source segment has a translation and no translation is
    // orphaned. A count comparison alone would call "one missing, one extra"
    // aligned, which is the exact mistake this view exists to prevent.
    aligned: unmatchedSource.length === 0 && unmatchedTranslation.length === 0,
  };
}

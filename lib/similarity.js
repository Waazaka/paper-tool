// Similarity notice: does this passage overlap material already in the library?
//
// The purpose is narrow and deliberately unfashionable. This is not an academic
// integrity check and cannot become one (D-015): it compares a passage against the evidence the
// user themselves stored, and reports which stored rows overlap. That answers a real
// question — "am I quoting the same passage again, or restating a claim I already
// cited?" — and answers nothing about originality, which is why no percentage is
// computed anywhere in this file.
//
// Three properties matter more than the matching quality:
//   1. No single score. A "similarity: 37%" number would be read as a detection rate
//      no matter what the caption said, so the output is a list of hits, not a number.
//   2. No advice. There is no "rewrite this" field; the plugin holds no model channel
//      (D-014) and rewriting is not this tool's role.
//   3. Nothing leaves the machine. The comparison runs against the local evidence
//      table only; no text is sent anywhere.

/** Shortest passage worth reporting. Below this a match is a coincidence of words. */
export const MIN_PROBE_CHARS = 8;

/** A hit must cover at least this many characters to be reported. */
export const MIN_OVERLAP_CHARS = 12;

/** Cap on returned hits: a report with 200 rows is scrolled past, not read. */
export const MAX_HITS = 20;

function normalise(text) {
  return String(text ?? "")
    // Whitespace and punctuation differ between a PDF extraction and a typed passage
    // while the words are identical, so neither may affect the comparison.
    .replace(/[\s\u3000]+/g, "")
    .toLowerCase();
}

/**
 * Length of the longest common substring between two already-normalised strings.
 *
 * Plain O(n·m) dynamic programming. Passages are short (a paragraph), the corpus is
 * the user's own evidence, and an algorithm nobody can re-derive from the code is a
 * worse trade than the milliseconds an index would save.
 *
 * @returns {number}
 */
export function longestCommonRun(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left === "" || right === "") return 0;
  let best = 0;
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    const char = left.charCodeAt(i - 1);
    for (let j = 1; j <= right.length; j += 1) {
      if (char === right.charCodeAt(j - 1)) {
        const run = previous[j - 1] + 1;
        current[j] = run;
        if (run > best) best = run;
      } else {
        current[j] = 0;
      }
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return best;
}

/**
 * Find stored evidence rows that overlap the probe text.
 *
 * @param {string} probe the text to check
 * @param {Array<{evidenceId: string, paperId: string, paperTitle?: string, pageIndex: number, quote: string}>} rows
 * @param {{minOverlap?: number, maxHits?: number}} [options]
 * @returns {{hits: Array<object>, enoughText: boolean, note: string, checked: number}}
 */
export function findByOverlap(probe, rows, options = {}) {
  const minOverlap = Number.isInteger(options.minOverlap) ? options.minOverlap : MIN_OVERLAP_CHARS;
  const maxHits = Number.isInteger(options.maxHits) ? options.maxHits : MAX_HITS;
  const needle = normalise(probe);
  const available = Array.isArray(rows) ? rows : [];

  if (needle.length < MIN_PROBE_CHARS) {
    return {
      hits: [],
      enoughText: false,
      checked: 0,
      // Saying "no overlap" for a 3-character probe would be a false reassurance: there
      // is nothing to compare yet.
      note: `待检查的文字太短（少于 ${MIN_PROBE_CHARS} 字），无法与库内材料比较。`,
    };
  }

  const hits = [];
  for (const row of available) {
    if (row === null || typeof row !== "object") continue;
    const haystack = normalise(row.quote);
    if (haystack === "") continue;
    const run = longestCommonRun(needle, haystack);
    if (run < minOverlap) continue;
    hits.push({
      evidenceId: row.evidenceId,
      paperId: row.paperId,
      paperTitle: row.paperTitle ?? "",
      pageIndex: row.pageIndex,
      quote: row.quote,
      overlapChars: run,
    });
  }
  hits.sort((a, b) => b.overlapChars - a.overlapChars || String(a.evidenceId).localeCompare(String(b.evidenceId)));
  const capped = hits.slice(0, maxHits);
  const note = capped.length === 0
    ? `与库内 ${available.length} 条证据比对，没有发现连续 ${minOverlap} 字以上的重叠。`
    : `与库内 ${available.length} 条证据比对，发现 ${hits.length} 条重叠${hits.length > capped.length ? `（只显示前 ${capped.length} 条）` : ""}。`;
  return { hits: capped, enoughText: true, checked: available.length, note };
}

/**
 * The disclaimer that must accompany every result, kept here so the UI and the RPC
 * cannot drift apart on it.
 */
export const SIMILARITY_DISCLAIMER =
  "仅作辅助提示：只与你自己库里已存的证据比对，不联网、不评判原创性，也不是查重率。" +
  "它回答的是「这段是不是又引了同一批材料」，不是「这段能不能通过检测」。";

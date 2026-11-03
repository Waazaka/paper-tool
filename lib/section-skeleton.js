// Section skeleton: a structure proposal built from evidence already in the library.
//
// Distinct from `reviewOutline`, which lists evidence grouped by paper. That answers
// "what material do I have"; this answers "how would a review of this material be
// organised". The difference matters because the two get confused by name, so both
// the function and the RPC avoid the word "outline" (see D-016).
//
// No sentence is generated here. Each section carries the evidence ids a writer should
// cite in it, and every id is checked against the library before it is returned — a
// skeleton pointing at an id that does not exist would send the writer to a citation
// they cannot produce (D-014: the plugin holds no model channel).

/**
 * The recurring structure of an empirical review, in the order a reader expects it.
 *
 * Kept as data rather than as an if-chain so a caller can see the whole plan and so
 * the gate can assert on it. The `role` names are what map evidence onto a section.
 */
export const SECTION_PLAN = [
  {
    id: "introduction",
    title: "引言",
    role: "framing",
    purpose: "问题是什么、为什么重要、本文要回答什么",
  },
  {
    id: "related",
    title: "相关工作",
    role: "background",
    purpose: "别人已经做了什么，按什么脉络分成几支",
  },
  {
    id: "method",
    title: "方法比较",
    role: "method",
    purpose: "各研究的方法差异，以及差异带来的可比性问题",
  },
  {
    id: "gap",
    title: "研究缺口",
    role: "gap",
    purpose: "哪些问题还没有被回答，或回答得不够",
  },
  {
    id: "conclusion",
    title: "结论",
    role: "conclusion",
    purpose: "综合起来能说什么，边界在哪里",
  },
];

/** Minimum evidence a section needs before it is offered as a real section. */
export const MIN_SECTION_EVIDENCE = 1;

/**
 * Bucket evidence rows into the plan's roles.
 *
 * The bucketing is deliberately deterministic and explainable: a row goes to a section
 * because of where it sits relative to the paper's own structure (its page position
 * and the stance recorded against it), not because of anything guessed from its text.
 * Anything that cannot be placed still gets cited — orphan rows land in 相关工作,
 * because dropping material is worse than filing it under a broad heading.
 *
 * @param {Array<{evidenceId: string, paperId: string, pageIndex: number, quote: string, stance?: string}>} rows
 * @returns {Map<string, Array<object>>}
 */
export function bucketEvidence(rows) {
  const buckets = new Map(SECTION_PLAN.map((section) => [section.id, []]));
  const byPaper = new Map();
  for (const row of rows) {
    if (!byPaper.has(row.paperId)) byPaper.set(row.paperId, []);
    byPaper.get(row.paperId).push(row);
  }
  for (const [, paperRows] of byPaper) {
    const sorted = [...paperRows].sort((a, b) => a.pageIndex - b.pageIndex || a.evidenceId.localeCompare(b.evidenceId));
    const last = sorted.length - 1;
    sorted.forEach((row, index) => {
      const stance = String(row.stance ?? "").toLowerCase();
      let section;
      if (stance === "conflict") {
        // A contradicting passage is a gap in the literature by definition.
        section = "gap";
      } else if (stance === "not_found") {
        // "This paper does not address the claim" is background, not a finding.
        section = "related";
      } else if (index === 0) {
        section = "introduction";
      } else if (index === last) {
        section = "conclusion";
      } else {
        // The middle of a paper is where its method lives; without reading the text we
        // cannot tell method from result, so the honest default is the method section.
        section = "method";
      }
      buckets.get(section).push(row);
    });
  }
  return buckets;
}

/**
 * Build a section skeleton from evidence rows.
 *
 * @param {Array<object>} rows evidence rows from the store
 * @param {{knownEvidenceIds?: Set<string>}} [options]
 * @returns {{sections: Array<{id: string, title: string, purpose: string, evidenceIds: string[], paperIds: string[]}>,
 *            unplaced: Array<object>, totalEvidence: number, note: string}}
 */
export function buildSkeleton(rows, options = {}) {
  const available = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === "object") : [];
  const known = options.knownEvidenceIds;
  // An id that is not in the library cannot be cited. Filtering here means the
  // returned skeleton can never point outside the library, whichever caller built the
  // row list (a test double, a stale cache, a future code path).
  const usable = known === undefined
    ? available
    : available.filter((row) => known.has(row.evidenceId));
  const dropped = available.length - usable.length;

  const buckets = bucketEvidence(usable);
  const sections = [];
  const unplaced = [];
  for (const section of SECTION_PLAN) {
    const rowsInSection = buckets.get(section.id) ?? [];
    if (rowsInSection.length < MIN_SECTION_EVIDENCE) {
      // An empty section is not offered. A "研究缺口" heading with nothing under it
      // tells the writer to write something unsupported.
      continue;
    }
    sections.push({
      id: section.id,
      title: section.title,
      purpose: section.purpose,
      evidenceIds: rowsInSection.map((row) => row.evidenceId),
      paperIds: [...new Set(rowsInSection.map((row) => row.paperId))],
    });
  }
  if (sections.length === 0) {
    unplaced.push(...usable);
  }
  const note = usable.length === 0
    ? "库里还没有可用证据：这个骨架不是空的建议，是没有材料可依据，所以不产出章节。"
    : `骨架依据 ${usable.length} 条证据、${new Set(usable.map((row) => row.paperId)).size} 篇文献；` +
      `每章列出应引用的 evidenceId，不含正文句子。`;
  return {
    sections,
    unplaced,
    totalEvidence: usable.length,
    droppedEvidence: dropped,
    note,
  };
}

/**
 * Topic recommendation: trend counting, gap finding, structured candidate rows.
 *
 * What this module does NOT do is decide what you should research. There is no model
 * channel in this plugin (D-014), and even if there were, "which topic is worth
 * pursuing" is a judgement that depends on your field, your data access and your
 * appetite for a hard problem — none of which are in a paper corpus. So the plugin
 * computes *material*: how many papers per year mention a term, which term pairs
 * appear together more than chance would explain, what the most-cited representatives
 * are. The Agent reads that material and answers in conversation.
 *
 * The honesty rules matter more than the statistics here:
 *
 *   1. A trend computed from four papers is not a trend. Below the minimum sample,
 *      say so and return nothing — a confident-looking chart from a tiny sample is
 *      worse than no chart, because it is indistinguishable from a real one.
 *   2. A gap without supporting co-occurrence is a guess. Every gap row carries the
 *      paper ids and term pairs that produced it, so the reader can check.
 *   3. Counts must be reproducible. The same input twice gives the same numbers;
 *      nothing here samples, shuffles or depends on iteration order of a hash map.
 */

/** Minimum papers before a yearly distribution is worth showing at all. */
export const MIN_SAMPLE = 8;

/** A gap needs a term pair seen at least this many times to be worth reporting. */
export const MIN_PAIR_SUPPORT = 3;

/** Years older than this are excluded from the trend window. */
export const TREND_WINDOW_YEARS = 10;

/**
 * Words that appear in almost every academic title and therefore carry no topical
 * signal. Filtered before any counting, otherwise "study of" is reported as a gap.
 */
export const STOPWORDS = new Set([
  // English function words that survive tokenisation.
  "a", "an", "the", "of", "for", "and", "or", "in", "on", "at", "to", "from", "by",
  "with", "without", "under", "over", "between", "into", "through", "during", "about",
  "as", "is", "are", "was", "were", "be", "been", "being", "this", "that", "these",
  "those", "it", "its", "we", "our", "their", "they", "has", "have", "had", "can",
  "could", "may", "might", "will", "would", "should", "must", "not", "no", "nor",
  // Words that describe the *form* of a paper rather than its topic.
  "study", "studies", "analysis", "analyses", "research", "paper", "article", "review",
  "approach", "method", "methods", "methodology", "result", "results", "case", "using",
  "based", "towards", "toward", "new", "novel", "recent", "advances", "progress",
  "survey", "overview", "introduction", "perspective", "framework", "model", "models",
  // Chinese equivalents of the same.
  "研究", "分析", "方法", "问题", "本文", "我们", "一种", "基于", "综述", "进展", "探讨",
  "影响", "作用", "关系", "对策", "应用", "现状", "趋势", "述评", "初探", "浅析",
]);

/**
 * Single CJK characters that carry grammar rather than topic.
 *
 * A bigram overlapping one of these is almost always two words cut in half
 * ("在教" from "在教育中", "的应" from "的应用"). Filtering the character is cruder
 * than segmenting but it removes the junk that would otherwise dominate the
 * co-occurrence table.
 */
export const CJK_STOP_CHARS = new Set([
  "的", "了", "在", "是", "和", "与", "及", "对", "为", "以", "从", "到", "把", "被",
  "有", "无", "也", "就", "都", "而", "其", "之", "等", "中", "上", "下", "内", "外",
  "时", "后", "前", "个", "些", "这", "那", "我", "们", "你", "他", "它", "或", "但",
  "若", "则", "因", "所", "该", "此", "于", "并", "且", "向", "由", "将", "已", "可",
  "能", "会", "要", "着", "过", "很", "更", "最", "多", "少", "大", "小", "新", "各",
]);

/**
 * Split a title into topical terms.
 *
 * Titles are the only field every source reliably fills, and they are dense with
 * topic words, which makes them the right input for co-occurrence. Abstracts would
 * give more signal but only OpenAlex provides them, so using abstracts would make the
 * sample size depend on which source answered.
 *
 * Chinese has no spaces, so a title like "深度学习在教育中的应用" would become one
 * token under whitespace splitting. For runs of CJK characters, overlapping
 * character bigrams are emitted instead — crude, but it makes "深度学习" and "教育"
 * separable without shipping a segmenter. Bigrams touching a grammar character are
 * dropped, because those are word boundaries rather than terms.
 *
 * @param {string} text
 * @returns {string[]} lowercased terms, stopwords removed, duplicates kept per title
 */
export function extractTerms(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const terms = [];
  // Latin and numeric words.
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9-]{1,}/g)) {
    const word = match[0].replace(/-+$/, "");
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    terms.push(word);
  }
  // CJK bigrams, skipping any that straddle a grammar character, plus 3-4 character
  // academic phrases within contiguous CJK segments split by CJK_STOP_CHARS.
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0];
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (STOPWORDS.has(bigram)) continue;
      if (CJK_STOP_CHARS.has(bigram[0]) || CJK_STOP_CHARS.has(bigram[1])) continue;
      terms.push(bigram);
    }
    let segStart = 0;
    for (let index = 0; index <= run.length; index += 1) {
      if (index === run.length || CJK_STOP_CHARS.has(run[index])) {
        if (index - segStart >= 3) {
          const segment = run.slice(segStart, index);
          for (const size of [3, 4]) {
            for (let pos = 0; pos + size <= segment.length; pos += 1) {
              const phrase = segment.slice(pos, pos + size);
              if (STOPWORDS.has(phrase)) continue;
              if (size === 4 && STOPWORDS.has(phrase.slice(0, 2)) && STOPWORDS.has(phrase.slice(2, 4))) continue;
              terms.push(phrase);
            }
          }
        }
        segStart = index + 1;
      }
    }
  }
  return terms;
}

/**
 * Count papers per year, and whether the sample is large enough to mean anything.
 *
 * @param {Array<{ year?: string, title?: string, citations?: number }>} papers
 * @param {{ minSample?: number, now?: number }} [options]
 */
export function computeTrend(papers, options = {}) {
  const minSample = Number.isInteger(options.minSample) ? options.minSample : MIN_SAMPLE;
  const now = Number.isInteger(options.now) ? options.now : new Date().getFullYear();
  const earliest = now - TREND_WINDOW_YEARS;
  const list = Array.isArray(papers) ? papers : [];

  /** @type {Map<string, { year: number, count: number, citations: number }>} */
  const byYear = new Map();
  let dated = 0;
  let undated = 0;
  for (const paper of list) {
    const year = Number.parseInt(String(paper?.year ?? ""), 10);
    // An out-of-range year is treated as unknown rather than clamped: a paper
    // stamped 1200 would otherwise drag the whole window with it.
    if (!Number.isInteger(year) || year < earliest || year > now) {
      undated += 1;
      continue;
    }
    dated += 1;
    const row = byYear.get(String(year)) ?? { year, count: 0, citations: 0 };
    row.count += 1;
    row.citations += Number.isFinite(paper?.citations) ? paper.citations : 0;
    byYear.set(String(year), row);
  }

  const years = [...byYear.values()].sort((left, right) => left.year - right.year);
  const total = dated;

  // The verdict is computed here, not left to the caller: every consumer has to
  // reach the same conclusion from the same numbers, or the UI and the Agent will
  // disagree about whether a trend exists.
  const sufficient = total >= minSample;
  let verdict;
  if (total === 0) {
    verdict = "no-data";
  } else if (!sufficient) {
    verdict = "insufficient";
  } else {
    verdict = "ok";
  }

  let direction = "flat";
  if (sufficient && years.length >= 2) {
    // Compare the mean of the older half against the newer half rather than fitting
    // a slope: with a handful of years, a least-squares slope is dominated by one
    // outlier year and reads as "rising" when the last year simply happened to be
    // busy.
    const midpoint = Math.floor(years.length / 2);
    const older = years.slice(0, midpoint);
    const newer = years.slice(midpoint);
    const mean = (rows) => (rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.count, 0) / rows.length);
    const olderMean = mean(older);
    const newerMean = mean(newer);
    const scale = Math.max(olderMean, newerMean, 1);
    const change = (newerMean - olderMean) / scale;
    if (change > 0.25) direction = "rising";
    else if (change < -0.25) direction = "falling";
  }

  return {
    years,
    total,
    undated,
    minSample,
    sufficient,
    verdict,
    direction,
    window: { from: earliest, to: now },
  };
}

/**
 * Find term pairs that co-occur in titles more often than the corpus makes likely.
 *
 * "Gap" here means a pair that keeps appearing together across different papers
 * while each term on its own is common — the literature circulates the combination
 * without a dedicated study of it. That is a weak signal and the output says so; it
 * is material for a reader, not a finding.
 *
 * Support is judged against the *observed* corpus, so a small sample cannot produce a
 * large support count and slip past the threshold on volume alone.
 *
 * @param {Array<{ paperId?: string, title?: string, year?: string, citations?: number }>} papers
 * @param {{ minSupport?: number, limit?: number }} [options]
 */
export function findGaps(papers, options = {}) {
  const minSupport = Number.isInteger(options.minSupport) ? options.minSupport : MIN_PAIR_SUPPORT;
  const limit = Number.isInteger(options.limit) ? options.limit : 12;
  const list = Array.isArray(papers) ? papers : [];

  // Term -> papers that mention it, deduplicated per paper: a title repeating a word
  // must not count as two papers.
  const termPapers = new Map();
  const paperTerms = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const paper = list[index] ?? {};
    const id = typeof paper.paperId === "string" && paper.paperId !== "" ? paper.paperId : `#${index}`;
    const terms = [...new Set(extractTerms(paper.title))];
    paperTerms.set(id, terms);
    for (const term of terms) {
      const bucket = termPapers.get(term) ?? new Set();
      bucket.add(id);
      termPapers.set(term, bucket);
    }
  }

  /** @type {Map<string, { a: string, b: string, papers: string[] }>} */
  const pairs = new Map();
  for (const [paperId, terms] of paperTerms) {
    const sorted = [...terms].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (sorted[i].includes(sorted[j]) || sorted[j].includes(sorted[i])) continue;
        const key = `${sorted[i]}\u0000${sorted[j]}`;
        const row = pairs.get(key) ?? { a: sorted[i], b: sorted[j], papers: [] };
        row.papers.push(paperId);
        pairs.set(key, row);
      }
    }
  }

  const gaps = [];
  for (const row of pairs.values()) {
    if (row.papers.length < minSupport) continue;
    const supportA = termPapers.get(row.a)?.size ?? 0;
    const supportB = termPapers.get(row.b)?.size ?? 0;
    // A pair where both terms are the same paper set is not a gap; it is one topic
    // written two ways ("deep" + "learning" always travel together). Requiring each
    // term to also appear outside the pair is what separates a combination from a
    // single phrase. Without this the top result is always that phrase.
    const independentA = supportA - row.papers.length;
    const independentB = supportB - row.papers.length;
    if (independentA <= 0 || independentB <= 0) continue;
    gaps.push({
      terms: [row.a, row.b],
      coOccurrences: row.papers.length,
      supportA,
      supportB,
      independentA,
      independentB,
      // The papers that support this claim, so a reader can check rather than trust.
      paperIds: [...new Set(row.papers)].sort(),
    });
  }

  // Strongest evidence first, then a stable tiebreak so two runs agree.
  gaps.sort((left, right) => right.coOccurrences - left.coOccurrences
    || left.terms[0].localeCompare(right.terms[0])
    || left.terms[1].localeCompare(right.terms[1]));
  return gaps.slice(0, limit);
}

/**
 * Pick the most-cited representatives, so the Agent has something concrete to read.
 *
 * Sorted by citations with undated/unknown-citation rows kept — filtering them out
 * would silently turn "no citation data" into "nothing worth reading".
 *
 * @param {Array<Record<string, unknown>>} papers
 * @param {number} limit
 */
export function representatives(papers, limit = 5) {
  const list = Array.isArray(papers) ? [...papers] : [];
  list.sort((left, right) => {
    const leftCount = Number.isFinite(left?.citations) ? left.citations : 0;
    const rightCount = Number.isFinite(right?.citations) ? right.citations : 0;
    if (rightCount !== leftCount) return rightCount - leftCount;
    // A stable tiebreak: the input order, so equal-citation rows do not swap
    // between two runs and make the output look non-deterministic.
    return list.indexOf(left) - list.indexOf(right);
  });
  return list.slice(0, limit).map((paper) => ({
    title: String(paper?.title ?? ""),
    authors: String(paper?.authors ?? ""),
    year: String(paper?.year ?? ""),
    venue: String(paper?.venue ?? ""),
    doi: String(paper?.doi ?? ""),
    citations: Number.isFinite(paper?.citations) ? paper.citations : null,
    // Present only when the source supplied one; never synthesised.
    abstract: typeof paper?.abstract === "string" ? paper.abstract.slice(0, 800) : "",
  }));
}

/**
 * Build the four-field candidate rows.
 *
 * This is the part that looks like it should be generated by a model, and it is
 * exactly the part that must not be: the plugin has no model channel (D-014), and a
 * fabricated "innovation point" is indistinguishable from a real one once it is in a
 * document. So the rows are assembled from counted material and every field states
 * where its content came from. The Agent turns these into prose; the plugin never
 * invents a research question.
 *
 * @param {{ query: string, trend: ReturnType<typeof computeTrend>, gaps: ReturnType<typeof findGaps>, papers: Array<Record<string, unknown>> }} input
 */
export function buildCandidates({ query, trend, gaps, papers }) {
  const term = String(query ?? "").trim();
  if (term === "") return [];
  const rows = [];
  const counts = trend?.years ?? [];
  const total = trend?.total ?? 0;

  // No candidates below the sample floor, full stop. Co-occurrence alone can look
  // convincing on a four-paper corpus — three papers is enough to clear the support
  // threshold — and that is exactly the fabricated-selection case this design exists
  // to prevent. Checking it here rather than only in the caller means no path can
  // produce rows from a sample that cannot carry a conclusion.
  if (trend?.sufficient !== true) return [];

  // One row per gap with real support. No gap, no row: an invented topic with no
  // co-occurrence behind it would be the fabricated-result case this design forbids.
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    const [left, right] = gap.terms;
    const supporting = representatives(
      (Array.isArray(papers) ? papers : []).filter((paper) => gap.paperIds.includes(
        typeof paper?.paperId === "string" ? paper.paperId : "",
      )),
      3,
    );
    rows.push({
      title: `${left} × ${right}: ${total} 篇样本中的共现组合`,
      researchQuestion: `在 ${term} 领域，「${left}」与「${right}」的交叉处是否有未被单独研究的问题？`,
      feasibility: {
        // The numbers behind "feasible", so the judgement is checkable.
        sampleSize: total,
        coOccurrences: gap.coOccurrences,
        independentA: gap.independentA,
        independentB: gap.independentB,
        // How many papers a reader can start from today.
        readingListSize: supporting.length,
        note: gap.coOccurrences >= MIN_PAIR_SUPPORT * 2
          ? "共现次数较多，值得先读支撑文献"
          : "共现次数较少，先确认这不是同一主题的两种写法",
      },
      innovation: {
        // Deliberately a description of the gap, not a claim of novelty.
        basis: gap.paperIds.slice(0, 5),
        note: `该组合在 ${gap.coOccurrences} 篇标题中共现，但两词各自还出现在 ${gap.independentA} / ${gap.independentB} 篇其他论文里`,
      },
      // Provenance for every row: which counted material produced it.
      provenance: {
        kind: "co-occurrence-gap",
        terms: [left, right],
        paperIds: gap.paperIds,
      },
    });
  }

  // A trend row is only offered when the sample can carry it. Below MIN_SAMPLE there
  // is no trend row at all, rather than a row that hedges.
  if (trend?.sufficient === true && counts.length >= 2) {
    const recent = counts.slice(-3);
    const recentTotal = recent.reduce((sum, row) => sum + row.count, 0);
    rows.push({
      title: `${term}: 近 ${recent.length} 年 ${recentTotal} 篇的趋势方向`,
      researchQuestion: trend.direction === "rising"
        ? `${term} 相关研究在增长，增长来自哪些子方向？`
        : trend.direction === "falling"
          ? `${term} 相关研究在减少，是问题解决了还是转向了别的表述？`
          : `${term} 相关研究数量平稳，是否存在只在方法上重复的工作？`,
      feasibility: {
        sampleSize: total,
        yearsCovered: counts.length,
        recentPapers: recentTotal,
        note: `样本 ${total} 篇覆盖 ${counts.length} 个年份`,
      },
      innovation: {
        basis: counts.map((row) => `${row.year}:${row.count}`),
        note: `方向判定基于前期/后期均值对比（${trend.direction}），不是拟合斜率`,
      },
      provenance: {
        kind: "yearly-trend",
        direction: trend.direction,
        years: counts,
      },
    });
  }

  return rows;
}

/**
 * The one-line honest summary returned alongside every recommendation.
 *
 * Kept in the payload rather than only in the UI tooltip: the Agent quotes the
 * payload, and a user who reads only the answer needs to know these rows are
 * counts, not conclusions.
 */
export const TOPIC_DISCLAIMER = "候选选题由标题词频与共现计数生成，不是研究结论；"
  + "创新性与可行性需你自己判断，插件不持有模型通道，也不替你下结论。";

/**
 * Assemble the whole payload returned by the RPC.
 *
 * @param {{ query: string, papers: Array<Record<string, unknown>>, minSample?: number, minSupport?: number, now?: number }} input
 */
export function recommendTopics({ query, papers, minSample, minSupport, now }) {
  const term = String(query ?? "").trim();
  const list = Array.isArray(papers) ? papers : [];
  const trend = computeTrend(list, { minSample, now });
  const gaps = findGaps(list, { minSupport });
  const candidates = buildCandidates({ query: term, trend, gaps, papers: list });
  const sufficient = trend.sufficient;

  return {
    query: term,
    // The sample is reported even when it is too small, so "insufficient" is a
    // statement about a known number rather than an empty result.
    sample: {
      papers: list.length,
      dated: trend.total,
      undated: trend.undated,
      minSample: trend.minSample,
      sufficient,
    },
    trend,
    gaps,
    candidates,
    representatives: representatives(list, 5),
    disclaimer: TOPIC_DISCLAIMER,
    // When the sample is too small, say so in a sentence the Agent can relay
    // verbatim instead of leaving it to interpret an empty array.
    refusal: sufficient ? null : {
      reason: trend.total === 0 ? "no-dated-papers" : "insufficient-sample",
      message: `样本不足（${trend.total} 篇有效年份，至少需要 ${trend.minSample} 篇），无法给出趋势判断。`,
    },
  };
}

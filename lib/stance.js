/**
 * Deterministic stance classification for (claim, quote) pairs.
 *
 * ## What this is, and what it is not
 *
 * This is a **rule-based classifier**, not entailment. It cannot read. What it
 * can do — and what the previous implementation could not — is:
 *
 *  1. Refuse to answer "support" when the only evidence is that the two strings
 *     share a word. Overlap is used as a *routing* signal to pick the sentence
 *     worth judging; the judgement itself comes from cue structure.
 *  2. Say how strong the judgement is (strong / partial / weak) instead of
 *     emitting a flat "supports".
 *  3. Show its work: the sentence it picked, the terms that routed it there, and
 *     the cue that decided the polarity.
 *
 * The output carries `method: "lexical-rules"` so nothing downstream can present
 * it as a model's reading. Under D-014 the plugin holds no model channel; the
 * Agent can re-read any quote the user wants checked, and this layer's job is to
 * make the queue honest rather than to substitute for that reading.
 *
 * ## Known ceiling, stated openly
 *
 * Pure lexical rules cannot judge whether a sentence actually entails a claim.
 * "该模型在小样本上不一定优于基线" is handled as a *weak/partial* signal because
 * 不一定 is a hedge, but a claim/quote pair that contradicts through word choice
 * alone will still be missed. That is why every result carries a strength and a
 * rationale: the weakest bucket is the "go read this one" queue, not a verdict.
 */

/** Chinese characters, used to decide which overlap metric matters. */
const CJK = /[\u4e00-\u9fff]/;

/**
 * Cues that point a passage *against* the claim.
 *
 * Every entry here negates or contradicts explicitly. Deliberately absent:
 * bare directional verbs like 降低 / 减少 / reduce / lower. Their polarity depends
 * on the claim ("该方法降低误差" *supports* "该方法有效"), so treating them as
 * negation would flip correct support into conflict. A cue table that cannot
 * express "it depends" has to leave those out.
 */
const POLARITY_CUES = [
  // Chinese
  ["不支持", "不支持"],
  ["并不支持", "并不支持"],
  ["并不", "并不"],
  ["并未", "并未"],
  ["并非", "并非"],
  ["不一致", "不一致"],
  ["不相符", "不相符"],
  ["不符", "不符"],
  ["未能", "未能"],
  ["无法", "无法"],
  ["尚未", "尚未"],
  ["未发现", "未发现"],
  ["未见", "未见"],
  ["没有发现", "没有发现"],
  ["无显著", "无显著"],
  ["不显著", "不显著"],
  ["没有显著", "没有显著"],
  ["无明显", "无明显"],
  ["不明显", "不明显"],
  ["缺乏证据", "缺乏证据"],
  ["没有证据", "没有证据"],
  ["反而不", "反而不"],
  ["相反", "相反"],
  ["相悖", "相悖"],
  ["矛盾", "矛盾"],
  ["反驳", "反驳"],
  ["否定了", "否定了"],
  // English
  ["not support", "not support"],
  ["does not support", "does not support"],
  ["do not support", "do not support"],
  ["no significant", "no significant"],
  ["not significant", "not significant"],
  ["insignificant", "insignificant"],
  ["no evidence", "no evidence"],
  ["no difference", "no difference"],
  ["contradict", "contradict"],
  ["challeng", "challeng"],
  ["refut", "refut"],
  ["unlike", "unlike"],
  ["rather than", "rather than"],
  ["contrary to", "contrary to"],
  ["opposite", "opposite"],
  ["fails to", "fails to"],
  ["failed to", "failed to"],
  ["did not", "did not"],
  ["does not", "does not"],
];

/**
 * Negative/insufficiency cues whose polarity conflicts with a positive claim
 * when absent from the claim itself ("X 效果偏低" vs "X 有效" -> conflict;
 * "X 抑制 Y" vs "X 抑制 Y" -> agreement).
 */
const DIRECTIONAL_NEGATIVE_CUES = [
  ["偏低", "偏低"],
  ["不足", "不足"],
  ["微弱", "微弱"],
  ["负向", "负向"],
  ["负面", "负面"],
  ["抑制", "抑制"],
  ["阻碍", "阻碍"],
  ["削弱", "削弱"],
  ["缺乏", "缺乏"],
];

/**
 * Antonym pairs for graded adjectives.
 *
 * These are the one place a bare adjective earns a place in the polarity table,
 * because unlike 降低 / reduce (whose polarity depends on the claim) these pairs
 * are *directly* opposed: "成本低" against "成本较高" is a contradiction however
 * you read it, and the old table called it strong support at 80% coverage.
 *
 * Each entry is [low-side, high-side]. A match only counts when the claim uses
 * one side, the quote uses the other, AND both sides are adjacent to a shared
 * noun — otherwise "成本低但效率高" would be flagged against "成本高" for the
 * wrong clause.
 */
const ANTONYM_PAIRS = [
  ["低", "高"],
  ["低", "较高"],
  ["低", "偏高"],
  ["高", "低"],
  ["高", "较低"],
  ["高", "偏低"],
  ["大", "小"],
  ["大", "较小"],
  ["小", "大"],
  ["小", "较大"],
  ["快", "慢"],
  ["快", "较慢"],
  ["慢", "快"],
  ["强", "弱"],
  ["强", "较弱"],
  ["弱", "强"],
  ["多", "少"],
  ["多", "较少"],
  ["少", "多"],
  ["少", "较多"],
  ["较长", "短"],
  ["长", "短"],
  ["短", "长"],
  ["easy", "difficult"],
  ["easy", "hard"],
  ["difficult", "easy"],
  ["high", "low"],
  ["low", "high"],
  ["fast", "slow"],
  ["slow", "fast"],
  ["increase", "decrease"],
  ["increase", "reduce"],
  ["decrease", "increase"],
  ["reduce", "increase"],
];

/**
 * Whether the quote uses the opposite side of a graded adjective present in the
 * claim.
 *
 * Returns the matched pair label, or null. Only compares the two texts directly:
 * "成本低" vs "成本高" is a contradiction; "成本低" vs "成本降低" is not, because
 * 降低 is not in the pair table (its polarity depends on the claim).
 */
function antonymCue(claim, quote) {
  const claimText = String(claim ?? "").toLowerCase();
  const quoteText = String(quote ?? "").toLowerCase();
  for (const [claimSide, quoteSide] of ANTONYM_PAIRS) {
    if (!claimText.includes(claimSide)) continue;
    if (!quoteText.includes(quoteSide)) continue;
    // Both sides must describe the same thing, or "cost is low" against
    // "accuracy is high" reads as a contradiction about cost. The shared context
    // has to be a real word, not a two-character slice: an early version took any
    // 2-character window and accepted "is" from "the cost is low" / "the accuracy
    // is high", which turned two unrelated sentences into a conflict.
    const at = claimText.indexOf(claimSide);
    const before = claimText.slice(Math.max(0, at - 12), at);
    const after = claimText.slice(at + claimSide.length, at + claimSide.length + 12);
    // Function words are not context: "the cost is low" and "the accuracy is
    // high" both contain "the", and accepting that made an unrelated sentence a
    // contradiction. Only content words identify what an adjective modifies.
    const STOP = new Set(["the", "and", "for", "are", "was", "were", "has", "have",
      "with", "from", "that", "this", "which", "than", "its", "our", "their", "not"]);
    const contextWords = (text) => (text.match(/[a-z]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [])
      .filter((word) => !STOP.has(word));
    const shared = [...contextWords(before), ...contextWords(after)]
      .filter((word) => quoteText.includes(word) && !STOP.has(word));
    if (shared.length === 0) continue;
    return `${claimSide}→${quoteSide}`;
  }
  return null;
}

/**
 * Cues that weaken a passage without flipping it.
 *
 * Deliberately generous. Over-triggering here turns a "strong" into a "partial",
 * which is a safe direction to be wrong in; under-triggering would let a hedged
 * sentence be counted as firm support, which is the failure this task is about.
 */
const HEDGE_CUES = [
  ["可能", "可能"], ["也许", "也许"], ["或许", "或许"], ["似乎", "似乎"],
  ["倾向于", "倾向于"], ["未必", "未必"], ["不一定", "不一定"], ["有待", "有待"],
  ["推测", "推测"], ["假设", "假设"],
  ["may ", "may"], ["might ", "might"], ["could ", "could"],
  ["possibly", "possibly"], ["perhaps", "perhaps"], ["seem", "seem"],
  ["suggest", "suggest"], ["appear", "appear"], ["likely", "likely"],
  ["potential", "potential"], ["hypothes", "hypothes"],
];

/** Cues that limit scope — weaker than a hedge but still not firm support. */
const LIMITATION_CUES = [
  ["难以", "难以"],
  ["受限", "受限"],
  ["有待进一步", "有待进一步"],
  ["尚需", "尚需"],
  ["一定程度", "一定程度"],
  ["局部", "局部"],
  ["小样本", "小样本"], ["样本量小", "样本量小"], ["仅限于", "仅限于"],
  ["初步", "初步"], ["仅在", "仅在"], ["本期", "本期"],
  ["small sample", "small sample"], ["limited", "limited"],
  ["preliminary", "preliminary"], ["in this study only", "in this study only"],
];

/**
 * Split text into sentences.
 *
 * Sentence granularity matters more than it looks: a cue that appears elsewhere
 * in a long quote must not flip the polarity of the sentence that actually
 * matched the claim. "X 有效。然而 Y 无效。" contains 然而, but the support for a
 * claim about X lives in the first sentence.
 */
export function splitSentences(text) {
  return String(text ?? "")
    .split(/[。！？；!?;\n]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** Split text into comparable terms; CJK gets bigrams since it has no spaces. */
export function terms(text) {
  const value = String(text ?? "").toLowerCase();
  const words = value.match(/[a-z0-9]{2,}/g) ?? [];
  const cjkRuns = value.match(/[\u4e00-\u9fff]+/g) ?? [];
  const bigrams = [];
  for (const run of cjkRuns) {
    if (run.length === 1) bigrams.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) {
      bigrams.push(run.slice(index, index + 2));
    }
  }
  return [...new Set([...words, ...bigrams])];
}

/**
 * Length of the longest contiguous run shared by two strings.
 *
 * This is what keeps word order from being free. `研究方法` and `方法研究` share
 * the bigrams 方法 and 研究, so plain term overlap calls them the same phrase; the
 * longest shared *contiguous* run is only two characters, which is the honest
 * answer. Order is information in Chinese noun compounds, and bigram overlap
 * throws it away.
 */
export function longestCommonRun(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left === "" || right === "") return 0;
  let best = 0;
  // Rolling row of the DP table; O(len(left) * len(right)) time, O(len(right)) space.
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

/** Every cue in `table` that appears in `text`, as human-readable labels. */
function findCues(text, table, excludeText = "") {
  const haystack = String(text ?? "").toLowerCase();
  const excluded = String(excludeText ?? "").toLowerCase();
  const found = [];
  for (const [needle, label] of table) {
    const token = needle.toLowerCase();
    if (excluded !== "" && excluded.includes(token)) continue;
    if (haystack.includes(token)) {
      if (!found.includes(label)) found.push(label);
    }
  }
  return found;
}

function findPolarityCues(sentence, claimText) {
  const explicit = findCues(sentence, POLARITY_CUES);
  const directional = findCues(sentence, DIRECTIONAL_NEGATIVE_CUES, claimText);
  return [...new Set([...explicit, ...directional])];
}

/**
 * Whether the claim's shared terms appear in the quote in the same order.
 *
 * A longest-shared-substring test was the obvious way to catch word-order traps,
 * but it fails the common case: "该方法可行" against "该方法尚未验证可行性" shares
 * only 该方法 contiguously (3 characters) even though the claim's content survives
 * in order, separated by an inserted clause. Penalising that would grade a direct
 * contradiction as weak.
 *
 * What actually distinguishes a trap from a paraphrase is relative order:
 * 研究方法 and 方法研究 share every bigram but present them inverted. So this
 * compares positions of the terms that do occur, and only inversion counts.
 */
function orderPreserved(claim, quote) {
  const haystack = String(quote ?? "").toLowerCase();
  const positions = [];
  for (const term of terms(claim)) {
    const at = haystack.indexOf(term);
    if (at >= 0) positions.push(at);
  }
  if (positions.length < 2) return true;
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] < positions[index - 1]) return false;
  }
  return true;
}

/**
 * How much of the claim's vocabulary the sentence carries.
 *
 * Returns the share of claim terms present. When a CJK claim's terms are present
 * but reordered, the coverage is capped at 0.25: the words are all there, which
 * is precisely why the surface looks like agreement, but the compound has been
 * turned around and no longer says the same thing.
 */
function coverageOf(claimTerms, sentenceTerms, claim, sentence) {
  if (claimTerms.length === 0) return 0;
  const present = claimTerms.filter((term) => sentenceTerms.has(term)).length;
  const termRatio = present / claimTerms.length;

  if (!CJK.test(claim)) return termRatio;
  if (termRatio >= 0.6 && !orderPreserved(claim, sentence)) return 0.25;
  return termRatio;
}

/**
 * Classify one (claim, quote) pair.
 *
 * Deterministic by construction: no clock, no randomness, no iteration over an
 * unordered structure that affects the outcome. Same input, same output — which
 * is a requirement, not a happy accident, because a matrix that changes between
 * two runs cannot be reviewed.
 *
 * @returns {{
 *   stance: "support"|"conflict"|"not_found",
 *   strength: "strong"|"partial"|"weak",
 *   method: "lexical-rules",
 *   rationale: string,
 *   matchedTerms: string[],
 *   cues: string[],
 *   sentence: string
 * }}
 */
export function judgeStance(claim, quote) {
  const claimText = String(claim ?? "").trim();
  const quoteText = String(quote ?? "").trim();
  const empty = {
    stance: "not_found",
    strength: "weak",
    method: "lexical-rules",
    rationale: claimText === "" ? "没有给出论断，无法判定立场。" : "引文为空，无法判定立场。",
    matchedTerms: [],
    cues: [],
    sentence: "",
  };
  if (claimText === "" || quoteText === "") return empty;

  const claimTerms = terms(claimText);
  const sentences = splitSentences(quoteText);
  // A quote with no sentence break is one sentence; a quote that is only
  // punctuation falls back to itself rather than judging nothing.
  const candidates = sentences.length > 0 ? sentences : [quoteText];

  // Score every sentence, then pick the best. Selection order:
  //
  //   1. a sentence that carries a polarity cue wins, even if another sentence
  //      covers the claim slightly better — "该方法未能提升。该方法有效。" is a
  //      contradiction of the claim and picking the support sentence would
  //      report the opposite of what the passage says;
  //   2. otherwise the highest coverage;
  //   3. ties break by position, so the result never depends on iteration order.
  //
  // An earlier version sorted on coverage alone and silently lost the cue: the
  // sentence that shared no verb but carried 「未能」 ranked below the plain
  // restatement. That is a real misreading, not a test artefact.
  let best = null;
  for (const sentence of candidates) {
    const sentenceTerms = new Set(terms(sentence));
    const coverage = coverageOf(claimTerms, sentenceTerms, claimText, sentence);
    const matchedTerms = claimTerms.filter((term) => sentenceTerms.has(term));
    const cue = findPolarityCues(sentence, claimText).length > 0;
    const candidate = { sentence, coverage, matchedTerms, cue };
    if (best === null) { best = candidate; continue; }
    if (candidate.cue !== best.cue) { if (candidate.cue) best = candidate; continue; }
    if (candidate.coverage > best.coverage) best = candidate;
  }

  // Nothing in common: the literature is silent here. This is an answer, not a
  // failure, and it must stay distinct from "no evidence was collected".
  if (best === null || best.coverage <= 0) {
    return {
      ...empty,
      rationale: "引文与论断没有任何共同词项，判为未提及。",
      sentence: best?.sentence ?? "",
    };
  }

  const polarity = findPolarityCues(best.sentence, claimText);
  // A graded adjective turned around is a contradiction, not a nuance. Checked
  // separately from the cue tables because it is inherently relational: it needs
  // both texts, not just the quote.
  const antonym = antonymCue(claimText, best.sentence);
  if (antonym !== null) polarity.push(`方向相反 ${antonym}`);
  const hedges = findCues(best.sentence, HEDGE_CUES);
  const limitations = findCues(best.sentence, LIMITATION_CUES);
  // Word order inverted: every term is present but the compound is turned
  // around. This is the one case where lexical similarity is *known* to mislead,
  // so it is capped at weak and says why, rather than being graded on coverage
  // that the inversion has already made meaningless.
  const inverted = CJK.test(claimText) && best.coverage >= 0.25 && !orderPreserved(claimText, best.sentence);

  // Engagement thresholds, used for both polarities so the scale means one
  // thing: >= 0.5 the passage carries half the claim, >= 0.25 it engages a
  // recognisable part of it, below that it merely shares a word.
  const engagement = (coverage) => (coverage >= 0.5 ? "strong" : coverage >= 0.25 ? "partial" : "weak");

  if (polarity.length > 0) {
    // A passage that explicitly negates or contradicts the claim is a conflict.
    // Strength reflects how much of the claim it actually engages with: a
    // contradiction of one shared word is a hint, not a finding.
    const strength = inverted ? "weak" : engagement(best.coverage);
    return {
      stance: "conflict",
      strength,
      method: "lexical-rules",
      rationale: `命中反转线索「${polarity.join("、")}」，覆盖论断词项 ${Math.round(best.coverage * 100)}%${inverted ? "，但词序颠倒，可信度按弱处理" : ""}。`,
      matchedTerms: best.matchedTerms,
      cues: [...polarity, ...hedges, ...limitations],
      sentence: best.sentence,
    };
  }

  // Support, graded. A hedged or scope-limited sentence supports tentatively;
  // only a sentence that carries most of the claim and hedges nothing is strong.
  const weakened = hedges.length > 0 || limitations.length > 0;
  // A hedge or a scope limit downgrades one notch: "may be effective in a small
  // sample" is still support, but it is not the same finding as "is effective".
  const base = engagement(best.coverage);
  let strength = base;
  if (weakened) strength = base === "strong" ? "partial" : "weak";
  if (inverted) strength = "weak";

  const reasons = [];
  reasons.push(`覆盖论断词项 ${Math.round(best.coverage * 100)}%`);
  if (inverted) reasons.push("词序颠倒，词面相似不可信");
  if (hedges.length > 0) reasons.push(`含保留语「${hedges.join("、")}」`);
  if (limitations.length > 0) reasons.push(`含范围限制「${limitations.join("、")}」`);
  if (!weakened) reasons.push("无保留语或范围限制");

  return {
    stance: "support",
    strength,
    method: "lexical-rules",
    rationale: `${reasons.join("，")}。`,
    matchedTerms: best.matchedTerms,
    cues: [...hedges, ...limitations],
    sentence: best.sentence,
  };
}

export const STANCE_STRENGTHS = ["strong", "partial", "weak"];

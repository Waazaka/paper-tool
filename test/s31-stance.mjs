// Stance judgement quality (PT-009).
//
// The defect this closes: reviewMatrix decided "supports / contradicts / silent"
// from word overlap plus a 12-word negation list, then rendered the result as a
// conclusion line ("支持 N 篇 · 冲突 M 篇"). Two failures followed from that:
//
//   1. Any overlap that missed those 12 words became *support*. "该模型在小样本上
//      不一定优于基线" was counted as support for "该模型优于基线".
//   2. The output had no grades and no reasons, so a reader could not tell firm
//      support from a passing mention, and had no way to check either.
//
// Every assertion here is about observable output of the shipped classifier.
// Adversarial cases are listed with their expected verdict inline, so a wrong
// expectation is visible rather than hidden behind a pass count.
import { judgeStance, splitSentences, longestCommonRun, terms } from "../lib/stance.js";

const failures = [];
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === "" ? "" : " -> " + detail));
    failures.push(`${name} ${detail}`);
  }
}

// --- 1. the flat heuristic is gone, and a graded one replaced it --------
{
  const { readFileSync } = await import("node:fs");
  const host = readFileSync("lib/host-service.js", "utf8");
  check("the 12-word negation table is gone", !/NEGATIONS/.test(host));
  check("reviewMatrix delegates to the stance module", /judgeStance\(claim, item\.quote\)/.test(host));
  // The old inline path must not survive as a fallback: two judgements that can
  // disagree is worse than one that can be improved.
  check("no leftover inline overlap judgement",
    !/claimTerms\.filter\(\(term\) => quoteTerms\.has\(term\)\)/.test(host));
}

// --- 2. adversarial cases: each is a specific way the old code failed --
// Expected verdicts are deliberately conservative. Where a rule cannot tell,
// the expected answer is the *weaker* one — claiming strong support on a hedge
// is the exact bug being fixed.
const CASES = [
  // claim, quote, expected stance, expected strength, why
  ["该方法在低资源场景下有效", "该方法在低资源场景下有效，准确率提升 12%。", "support", "strong", "直接复述并给出数据"],

  // The reported defect: a hedge used to count as full support.
  ["该模型优于基线", "该模型在小样本上不一定优于基线。", "support", "partial", "含「不一定」，不能算强支持"],
  ["该模型优于基线", "该模型在小样本上可能优于基线。", "support", "partial", "含「可能」"],

  // The reported gap: 不显著 was missing while 无显著 was present.
  ["两组存在显著差异", "两组之间不显著。", "conflict", "partial", "「不显著」判冲突；覆盖约三成，故部分"],
  ["两组存在显著差异", "两组之间无显著差异。", "conflict", "strong", "「无显著」判冲突且覆盖过半"],
  ["两组存在显著差异", "两组之间没有显著差异。", "conflict", "strong", "「没有显著」"],

  // Negations that were absent from the old list.
  ["该方法可行", "该方法尚未验证可行性。", "conflict", "strong", "「尚未」曾被漏掉，现已收录"],
  ["该结论可靠", "该结论缺乏证据支持。", "conflict", "strong", "「缺乏证据」"],
  ["该方法适用", "该方法难以适用。", "support", "partial", "「难以」是限定而非反转，覆盖过半但被降档"],
  ["该现象存在", "该现象未见报道。", "conflict", "strong", "「未见」"],
  ["该现象存在", "该现象未发现。", "conflict", "strong", "「未发现」"],

  // Word-order trap: bigram overlap used to make these the same phrase.
  ["研究方法的改进", "方法研究的改进", "support", "weak", "词序颠倒，封顶为弱"],
  ["研究方法", "方法研究", "support", "weak", "纯词序颠倒，覆盖减半"],

  // Explicit contradiction.
  ["A 导致 B", "结果与 A 导致 B 相反。", "conflict", "strong", "「相反」"],
  ["该假设成立", "证据反驳了该假设成立的说法。", "conflict", "strong", "「反驳」"],
  ["A 与 B 一致", "A 与 B 不一致。", "conflict", "strong", "「不一致」"],

  // Silent: no shared vocabulary at all.
  ["气候模型预测升温", "本次实验测量了土壤含水量。", "not_found", "weak", "无共同词项"],

  // English cases.
  ["the method reduces error", "the method does not reduce error.", "conflict", "strong", "does not"],
  ["the method reduces error", "the method reduces error by 12%, though the sample was limited.", "support", "partial", "含范围限制 limited"],
  ["the method is effective", "there is no evidence that the method is effective.", "conflict", "strong", "no evidence"],
  ["the method is effective", "the method appears effective.", "support", "partial", "appears 是保留语"],

  // Mixed language.
  ["该方法 improves accuracy", "该方法 improves accuracy 但样本量小。", "support", "weak", "中英混合 + 范围限制把弱支持再降一档"],

  // Graded adjective pairs: directly opposed, unlike 降低/reduce whose polarity
  // depends on the claim. The old code called "成本低" vs "成本较高" strong
  // support at 80% coverage.
  ["该方案成本低", "该方案成本较高。", "conflict", "strong", "方向形容词相反"],
  ["该方案成本低", "该方案成本高。", "conflict", "strong", "方向形容词相反"],
  ["该方案效率高", "该方案效率较低。", "conflict", "strong", "方向形容词相反"],
  ["the error rate is low", "the error rate is high.", "conflict", "strong", "low vs high"],
  // The context guard: a shared adjective is not enough, the two must be about
  // the same thing. Without it "cost is low" vs "accuracy is high" reads as a
  // contradiction about cost.
  ["the cost is low", "the accuracy is high.", "support", "strong", "共享 the 不算同一主题"],
  // The contrast that must NOT fire: a shared topic with no opposing adjective.
  ["该方案成本低", "该方案成本降低。", "support", "strong", "降低 不在方向词对里，故不构成反转"],
];

for (const [claim, quote, expectedStance, expectedStrength, why] of CASES) {
  const result = judgeStance(claim, quote);
  const ok = result.stance === expectedStance && result.strength === expectedStrength;
  check(`${expectedStance.padEnd(9)} ${expectedStrength.padEnd(7)} | ${why}`,
    ok, `got ${result.stance}/${result.strength}: ${result.rationale}`);
}

// --- 2b. the cue must be in the sentence being judged ------------------
// A cue elsewhere in a multi-sentence quote must not flip the polarity of the
// sentence that matched. Without this, one "然而" anywhere in a paragraph would
// mark the whole passage as contradicting.
{
  const multi = judgeStance("该方法有效", "该方法有效，准确率提升 12%。然而后续工作仍需验证。");
  check("a contradiction elsewhere in the quote does not flip a supporting sentence",
    multi.stance === "support", `${multi.stance}: ${multi.rationale}`);
  const splitQuote = judgeStance("该方法有效", "该方法未能显著提升准确率。后续工作中该方法有效。");
  // The matching sentence carries the cue, so this one *is* a conflict.
  check("the sentence carrying the cue decides the polarity",
    splitQuote.stance === "conflict", `${splitQuote.stance}: ${splitQuote.rationale}`);
  // And the sentence reported must be the one judged, not the whole quote.
  check("the reported sentence is one sentence, not the whole quote",
    !splitQuote.sentence.includes("后续工作"), splitQuote.sentence);
}

// --- 3. strength is graded, not a relabelled boolean ------------------
{
  const grades = new Set();
  const stances = new Set();
  for (const [claim, quote] of CASES) {
    const result = judgeStance(claim, quote);
    grades.add(result.strength);
    stances.add(result.stance);
  }
  check("all three strengths occur across the case set", grades.size === 3, [...grades].join(","));
  check("conflict actually occurs (a matrix of all-support is not a review)",
    stances.has("conflict"), [...stances].join(","));
  check("not_found actually occurs", stances.has("not_found"), [...stances].join(","));
}

// --- 4. every judgement carries a checkable rationale ----------------
{
  let missing = null;
  for (const [claim, quote] of CASES) {
    const result = judgeStance(claim, quote);
    if (typeof result.rationale !== "string" || result.rationale.trim() === "") {
      missing = `${claim} / ${quote}: no rationale`;
      break;
    }
    // A rationale that does not name the sentence it judged cannot be checked by
    // a human. For a not_found verdict there is no sentence to quote.
    if (result.stance !== "not_found" && (result.sentence === "" || !quote.includes(result.sentence.slice(0, 4)))) {
      missing = `${claim} / ${quote}: rationale names no sentence`;
      break;
    }
    if (result.method !== "lexical-rules") { missing = `${claim}: unlabelled method`; break; }
  }
  check("every judgement carries a rationale and its source sentence", missing === null, missing ?? "");
  check("the method is labelled so it cannot pass as a model reading",
    judgeStance("a b c", "a b c d").method === "lexical-rules");
}

// --- 5. determinism ---------------------------------------------------
{
  let drift = null;
  for (const [claim, quote] of CASES) {
    const first = JSON.stringify(judgeStance(claim, quote));
    for (let repeat = 0; repeat < 3; repeat += 1) {
      if (JSON.stringify(judgeStance(claim, quote)) !== first) {
        drift = `${claim} / ${quote}`;
        break;
      }
    }
    if (drift !== null) break;
  }
  check("the same pair judges identically on repeated runs", drift === null, drift ?? "");
  // Compare the *verdicts* across many rounds, not merely that each round
  // produced something. A per-round completeness check cannot see a shuffle.
  // Tie-heavy probes: several sentences with byte-identical coverage but
  // different verdicts, so iteration order decides the answer. Order-dependent
  // code survives a "did it produce something" check but not this one.
  const TIE_CASES = [
    ["A 有效", "A 有效。B 有效。C 有效。D 有效。E 有效。"],
    ["研究方法与实验设计", "研究设计。方法实验。实验方法。设计研究。"],
    ["the method is effective", "the method is effective. it is effective. effective method is."],
    ["甲乙丙丁", "甲乙。乙甲。丙丁。丁丙。甲丁。丁甲。"],
  ];
  const baseline = [...CASES, ...TIE_CASES].map(([claim, quote]) => JSON.stringify(judgeStance(claim, quote)));
  let unstable = null;
  const allCases = [...CASES, ...TIE_CASES];
  for (let round = 0; round < 30 && unstable === null; round += 1) {
    for (let index = 0; index < allCases.length; index += 1) {
      const [claim, quote] = allCases[index];
      if (JSON.stringify(judgeStance(claim, quote)) !== baseline[index]) {
        unstable = `round ${round}: ${claim} / ${quote}`;
        break;
      }
    }
  }
  check("30 rounds produce byte-identical verdicts", unstable === null, unstable ?? "");
  // Sentence order must not decide a tie differently between runs.
  const sentences = splitSentences("甲。乙。丙。");
  check("sentence splitting is stable", JSON.stringify(sentences) === JSON.stringify(["甲", "乙", "丙"]),
    JSON.stringify(sentences));
}

// --- 6. the order-sensitivity helper works ---------------------------
{
  check("a shared contiguous run is measured", longestCommonRun("研究方法", "研究方法") === 4);
  check("reordered bigrams do not count as a long run", longestCommonRun("研究方法", "方法研究") === 2,
    String(longestCommonRun("研究方法", "方法研究")));
  check("no overlap is zero", longestCommonRun("abc", "xyz") === 0);
  check("an empty side is zero", longestCommonRun("", "abc") === 0);
  // The claim-side behaviour that the helper exists to enforce.
  const reordered = judgeStance("研究方法", "方法研究");
  const straight = judgeStance("研究方法", "研究方法");
  check("word order lowers the confidence even when terms match",
    reordered.strength !== "strong", reordered.strength);
  // The two must differ, and in a specific direction. "not both strong" would
  // pass if word order had no effect at all.
  check("an exact phrase is strong", straight.strength === "strong", straight.strength);
  check("a reordered phrase is weak", reordered.strength === "weak", reordered.strength);
  check("the reordered verdict says why", /词序/.test(reordered.rationale), reordered.rationale);
  // Capping the verdict at weak is not enough: the rationale is what the user
  // reads. Claiming "覆盖论断词项 100%" for an inverted compound would be a
  // number that looks like confirmation while the verdict says weak.
  const claimed = Number(/覆盖论断词项 (\d+)%/.exec(reordered.rationale)?.[1] ?? "-1");
  check("an inverted match does not claim full coverage", claimed >= 0 && claimed < 60, reordered.rationale);
}

// --- 7. the buckets stay separate, end to end -----------------------
// "not_found" (the literature is silent) and "no_evidence" (nothing was
// collected) are different findings. The previous implementation got this right
// and it must not regress while the judgement changes.
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadService } = await import("./shim.mjs");
  const { PaperToolService } = await loadService();

  const home = mkdtempSync(join(tmpdir(), "paper-tool-S31-home-"));
  const work = mkdtempSync(join(tmpdir(), "paper-tool-S31-work-"));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  const scope = { sessionId: "s31", workspaceRoot: work };
  const store = service.storeFor(scope);

  const addPaper = (id, title) => store.upsertPaper({
    paperId: id, title, authors: "A", year: "2021", venue: "V", doi: `10.1/${id}`,
    source: "test", pdfPath: "", fingerprint: `fp-${id}`, material: "fulltext",
  });
  addPaper("p-support", "Supporting paper");
  addPaper("p-conflict", "Contradicting paper");
  addPaper("p-silent", "Silent paper");
  addPaper("p-empty", "Paper with no evidence");

  store.addEvidence({ evidenceId: "e1", paperId: "p-support", pageIndex: 0, charStart: 0, charEnd: 10,
    quote: "该方法在低资源场景下有效，准确率提升 12%。" });
  store.addEvidence({ evidenceId: "e2", paperId: "p-conflict", pageIndex: 0, charStart: 0, charEnd: 10,
    quote: "两组之间不显著。" });
  store.addEvidence({ evidenceId: "e3", paperId: "p-silent", pageIndex: 0, charStart: 0, charEnd: 10,
    quote: "本次实验测量了土壤含水量。" });

  const matrix = await service.reviewMatrix(scope, { claim: "该方法在低资源场景下有效，两组存在显著差异" });
  const rowOf = (paperId) => matrix.rows.find((row) => row.paperId === paperId);
  const t = store.stats().papers;

  check("the four stances are all reachable", (() => {
    const seen = new Set(matrix.rows.map((row) => row.stance));
    return seen.has("support") && seen.has("conflict") && seen.has("not_found") && seen.has("no_evidence");
  })(), [...new Set(matrix.rows.map((row) => row.stance))].join(","));

  check("a supporting paper is graded", rowOf("p-support")?.strength !== null && rowOf("p-support")?.strength !== undefined,
    JSON.stringify(rowOf("p-support")?.strength));
  check("a contradicting paper is reported as conflict", rowOf("p-conflict")?.stance === "conflict",
    rowOf("p-conflict")?.stance);
  check("a silent paper is not_found, not conflict", rowOf("p-silent")?.stance === "not_found",
    rowOf("p-silent")?.stance);
  check("a paper with no evidence is no_evidence, not not_found",
    rowOf("p-empty")?.stance === "no_evidence", rowOf("p-empty")?.stance);

  // The invariant the criterion names: not_found and no_evidence are disjoint
  // and together with the rest must account for every paper.
  const counts = matrix.counts;
  const total = counts.support + counts.conflict + counts.not_found + counts.no_evidence;
  check("every paper lands in exactly one stance bucket", total === t, `${total} vs ${t}`);
  check("not_found and no_evidence are counted separately",
    typeof counts.not_found === "number" && typeof counts.no_evidence === "number");
  check("strength totals sum to the support count",
    counts.strong + counts.partial + counts.weak === counts.support,
    `${counts.strong}+${counts.partial}+${counts.weak} vs ${counts.support}`);

  // The row must expose the per-evidence work, not just a verdict.
  const supportRow = rowOf("p-support");
  check("a judged row carries per-evidence judgements", Array.isArray(supportRow?.judgements) && supportRow.judgements.length > 0);
  const judgement = supportRow?.judgements?.[0];
  check("a judgement names its evidence", judgement?.evidenceId === "e1", judgement?.evidenceId);
  check("a judgement carries a rationale", typeof judgement?.rationale === "string" && judgement.rationale !== "");
  check("a judgement quotes the sentence it judged",
    typeof judgement?.sentence === "string" && judgement.sentence !== "");
  check("a judgement carries its stance and strength",
    typeof judgement?.stance === "string" && typeof judgement?.strength === "string");

  // The summary line must report the grades, not hide them.
  check("the summary line shows the strength split",
    /强 \d+ \/ 部分 \d+ \/ 弱 \d+/.test(matrix.text), matrix.text.split("\n").slice(0, 2).join(" "));

  // And it must be deterministic across two full runs.
  const again = await service.reviewMatrix(scope, { claim: "该方法在低资源场景下有效，两组存在显著差异" });
  check("two matrix runs produce identical rows",
    JSON.stringify(matrix.rows) === JSON.stringify(again.rows), "rows differ between runs");

  // Coverage mode must still not judge anything.
  const coverage = await service.reviewMatrix(scope, {});
  check("a matrix without a claim makes no stance judgement",
    coverage.coverageOnly === true && coverage.rows.every((row) => ["covered", "empty"].includes(row.stance)),
    JSON.stringify(coverage.rows.map((row) => row.stance)));

  service.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 8. the empty claim is not a judgement --------------------------
{
  const empty = judgeStance("", "任意引文");
  check("no claim yields not_found with a reason", empty.stance === "not_found" && empty.rationale !== "");
  const noQuote = judgeStance("任意论断", "");
  check("no quote yields not_found with a reason", noQuote.stance === "not_found" && noQuote.rationale !== "");
  // A non-empty quote sharing nothing with the claim is "the literature is
  // silent", not support. This is the difference between no_evidence and
  // not_found expressed at the pair level.
  const disjoint = judgeStance("quantum entanglement", "土壤含水量测量");
  check("a quote sharing nothing with the claim is not support",
    disjoint.stance === "not_found", `${disjoint.stance}: ${disjoint.rationale}`);
  const disjointCjk = judgeStance("气候模型预测升温", "本次实验测量了土壤含水量。");
  check("a disjoint Chinese pair is not support", disjointCjk.stance === "not_found", disjointCjk.stance);
  // "There is no quote" and "the quote shares nothing with the claim" are both
  // not_found, but they are different situations and the reason must say which.
  // A caller that cannot tell them apart cannot tell "go collect evidence" from
  // "this paper does not address it".
  check("an empty quote is explained as empty",
    /引文为空/.test(noQuote.rationale), noQuote.rationale);
  check("a disjoint quote is explained as no shared terms",
    /没有任何共同词项/.test(disjointCjk.rationale), disjointCjk.rationale);


  check("terms still splits CJK into bigrams", terms("研究方法").length >= 2, String(terms("研究方法").length));
}

// --- 9. the UI shows the grade and the reason -------------------------
// Asserted through the mounted component rather than by grepping client.js:
// every one of these three mutations survived a source-text assertion, because
// the string stayed in the file while the value stopped reaching the DOM.
{
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { join, sep } = await import("node:path");
  const { installDom } = await import("./dom-stub.mjs");

  const ROOT = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules");
  const requireFromProfile = createRequire(join(ROOT, "noop.js"));
  let React;
  let createRoot;
  try {
    const domEntry = requireFromProfile.resolve("react-dom/server");
    const domRoot = domEntry.slice(0, domEntry.indexOf(`${sep}react-dom${sep}`));
    const requireFromDom = createRequire(join(domRoot, "noop.js"));
    ({ createRoot } = requireFromDom("react-dom/client"));
    React = requireFromDom("react");
  } catch (error) {
    console.log("  SKIP the UI section (react unavailable)");
    console.log(`  note: ${error.message}`);
  }
  if (React !== undefined) {
    installDom({ width: 360, height: 640 });
    let exported = null;
    globalThis.window.__ModuleLoader__ = {
      load({ factory }) {
        exported = factory((id) => {
          if (id === "react") return React;
          throw new Error(`unexpected require: ${id}`);
        });
      },
    };
    await import(pathToFileURL(join(process.cwd(), "client.js")).href);
    const { StanceBadge } = exported.__test;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const t = (key) => ({ support: "支持", conflict: "冲突", gradeStrong: "强", gradePartial: "部分", gradeWeak: "弱" })[key] ?? key;

    root.render(React.createElement("div", null,
      React.createElement(StanceBadge, { stance: "support", strength: "strong", t }),
      React.createElement(StanceBadge, { stance: "support", strength: "partial", t }),
      React.createElement(StanceBadge, { stance: "support", strength: "weak", t }),
      React.createElement(StanceBadge, { stance: "conflict", strength: null, t }),
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = host.textContent;

    check("the badge shows a strong grade", text.includes("支持·强"), text);
    check("the badge shows a partial grade", text.includes("支持·部分"), text);
    check("the badge shows a weak grade", text.includes("支持·弱"), text);
    check("a stance with no grade shows no grade suffix", text.includes("冲突") && !text.includes("冲突·"), text);
    // The three grades must be distinguishable, not three copies of one label.
    check("the three grades are distinct", new Set(["支持·强", "支持·部分", "支持·弱"].filter((label) => text.includes(label))).size === 3, text);
    try { root.unmount(); } catch { /* ignore */ }

    // --- the matrix view, driven end to end ---
    // Mounting StanceBadge directly proves the badge can render a grade; it does
    // not prove the matrix passes one. Two mutations (row drops `strength`,
    // matrix hides `judgements`) survived that weaker assertion, so the view is
    // exercised through the real component and a Host stand-in.
    const { Body, DICTS } = exported.__test;
    const makeT = (dict) => (key, params) => {
      const raw = dict[key];
      if (raw === undefined) return key;
      return params === undefined ? raw : String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
    };
    const tz = makeT(DICTS.zh);

    const matrixReply = {
      claim: "该方法有效",
      rows: [
        {
          paperId: "p1", title: "Supporting paper", year: "2021", stance: "support", strength: "strong",
          evidenceIds: ["e1"], notFoundEvidenceIds: [], supportCount: 1, conflictCount: 0, notFoundCount: 0,
          judgements: [{ evidenceId: "e1", stance: "support", strength: "strong", method: "lexical-rules",
            rationale: "覆盖论断词项 100%，无保留语或范围限制。", matchedTerms: ["方法"], cues: [], sentence: "该方法有效。" }],
        },
        {
          paperId: "p2", title: "Hedging paper", year: "2022", stance: "support", strength: "partial",
          evidenceIds: ["e2"], notFoundEvidenceIds: [], supportCount: 1, conflictCount: 0, notFoundCount: 0,
          judgements: [{ evidenceId: "e2", stance: "support", strength: "partial", method: "lexical-rules",
            rationale: "覆盖论断词项 60%，含保留语「可能」。", matchedTerms: [], cues: ["可能"], sentence: "该方法可能有效。" }],
        },
      ],
      counts: { support: 2, conflict: 0, not_found: 0, no_evidence: 0, strong: 1, partial: 1, weak: 0 },
      text: "论断：「该方法有效」\n支持 2 篇（强 1 / 部分 1 / 弱 0） · 冲突 0 篇 · 未提及 0 篇",
    };

    const calls = [];
    const ctx = {
      connection: { rpc: { async call(_path, method, options) {
        const bare = String(method).replace(/^paperTool\//, "");
        calls.push(bare);
        const value = bare === "reviewMatrix" ? matrixReply
          : bare === "status" ? { library: { papers: 2, pages: 20, evidence: 2 } }
            : bare === "listPapers" ? { papers: [], library: { papers: 2 }, paging: { total: 2, hasMore: false } }
              : bare === "listEvidence" ? { evidence: [], paging: { total: 0, hasMore: false, anchoredTotal: 0, allTotal: 0 } }
                : bare === "listAnnotations" ? { annotations: [] } : {};
        return { ok: true, value };
      } } },
      locale: { register() {}, bind: () => tz },
      slots: { inject() {}, register: () => ({}) },
      sidebarRightTabs: { register: () => ({}) },
      effect() {},
    };
    exported.apply(ctx);

    const bodyHost = document.createElement("div");
    document.body.appendChild(bodyHost);
    const bodyRoot = createRoot(bodyHost);
    bodyRoot.render(React.createElement(Body, { sessionId: "s31-ui", inputActions: { captureInsertion() {}, insertText() {} }, t: tz }));
    const settle = async (turns = 14) => { for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0)); };
    await settle();

    // Switch to the review tab and run a matrix.
    // The stance matrix lives on the evidence tab (it judges evidence rows), not
    // on the review tab, which holds outline/citations/export.
    const tab = [...bodyHost.querySelectorAll("button")]
      .find((b) => b.textContent.trim().startsWith(DICTS.zh.evidenceTab));
    if (tab === undefined) {
      check("the evidence tab is reachable", false, JSON.stringify([...bodyHost.querySelectorAll("button")].map((b) => b.textContent.trim()).slice(0, 10)));
    } else {
      tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle();
      // Locate by aria-label, not placeholder: the DOM stub reflects attributes
      // but has no `placeholder` accessor, so matching on it always finds nothing.
      const allInputs = [...bodyHost.querySelectorAll("input")];
      const input = allInputs.find((el) => el.getAttribute("aria-label") === tz("claimPlaceholder"));
      check("the claim box is present", input !== undefined,
        JSON.stringify(allInputs.map((el) => el.getAttribute("aria-label"))));
      if (input !== undefined) {
        const { typeInto } = await import("./dom-stub.mjs");
        typeInto(input, "该方法有效", window.Event);
        await settle(4);
        const runButton = [...bodyHost.querySelectorAll("button")].find((b) => b.textContent.trim() === tz("checkStance"));
        check("the stance button is present", runButton !== undefined,
          JSON.stringify([...bodyHost.querySelectorAll("button")].map((b) => b.textContent.trim()).slice(0, 14)));
        runButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await settle();
        check("the matrix request was issued", calls.includes("reviewMatrix"), calls.join(","));

        const bodyText = bodyHost.textContent;
        check("the matrix view shows a strong grade", bodyText.includes("支持·强"), bodyText.slice(0, 300));
        check("the matrix view shows a partial grade", bodyText.includes("支持·部分"), bodyText.slice(0, 300));
        // The rationale must reach the DOM, not just the RPC payload.
        check("the matrix view shows the per-evidence reason",
          bodyText.includes("覆盖论断词项 100%"), bodyText.slice(0, 400));
        check("the matrix view shows the hedge reason", bodyText.includes("含保留语"), bodyText.slice(0, 400));
        check("the matrix summary reports the grade split", /强 1 \/ 部分 1 \/ 弱 0/.test(bodyText), bodyText.slice(0, 300));
      }
    }
    try { bodyRoot.unmount(); } catch { /* ignore */ }
  }
}

if (failures.length > 0) {
  console.log("\nSTANCE FAILED (" + failures.length + "):");
  for (const failure of failures) console.log(" - " + failure);
  process.exit(1);
}
console.log("\nSTANCE PASS");

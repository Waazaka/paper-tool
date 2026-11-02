// Inline ask: the plugin builds a grounded packet, the Agent answers (D-014).
//
// What this gate defends, in order of how easily it could silently break:
//   1. The anchor is computed from the stored page text, not received from the caller.
//      If the Host trusted a caller-supplied charStart, a wrong anchor would be
//      indistinguishable from a right one and every citation would be unverifiable.
//   2. A selection that cannot be located is reported as unanchored (-1), never given
//      a plausible-looking offset.
//   3. The answer can be written back to the same anchor — as a note, and as evidence
//      only when the paper's own words are supplied.
//   4. Asking does not create anything. The write-back is a separate, deliberate act.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadService } from "./shim.mjs";

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const dir = mkdtempSync(join(tmpdir(), "ask-gate-"));
const { PaperToolService } = await loadService();
const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: dir });
const scope = { sessionId: "ask", workspaceRoot: dir };
const store = service.storeFor(scope);

const PAGE0 =
  "Servicescape shapes customer citizenship behaviour in hotels. " +
  "The mechanism is customer engagement, which mediates the relationship. " +
  "Psychological ownership is a second pathway discussed on this page.";
const PAGE1 =
  "The second page turns to boundary conditions. " +
  "High workload weakens the servicescape effect.";

store.upsertPaper({
  paperId: "p1", title: "Servicescape and citizenship", authors: "Li, Shuhao",
  year: "2021", venue: "IJCHM", doi: "10.1/p1", source: "import", pdfPath: "",
  fingerprint: "f1", material: "fulltext",
  pages: [PAGE0, PAGE1],
  pageSources: ["text-layer", "text-layer"],
});

// --- 1. the anchor is computed, and lands on the real page --------------
{
  const selection = "customer engagement, which mediates";
  const packet = await service.askContext(scope, { paperId: "p1", question: "机制是什么", selectionText: selection });
  check("the packet reports the page the passage is on", packet.selection.pageIndex === 0,
    String(packet.selection.pageIndex));
  check("the passage is reported as anchored", packet.selection.anchored === true);
  // The load-bearing assertion: slice the stored page text with the returned offsets
  // and require it to equal the selection. This is what makes the anchor verifiable
  // rather than decorative.
  const sliced = store.getPageText("p1", packet.selection.pageIndex)
    .slice(packet.selection.charStart, packet.selection.charEnd);
  check("the returned offsets slice the stored text back to the exact passage",
    sliced === selection, JSON.stringify(sliced));
  check("charEnd is charStart plus the selection length",
    packet.selection.charEnd - packet.selection.charStart === selection.length,
    String(packet.selection.charEnd - packet.selection.charStart));
  check("the question is carried through unchanged", packet.question === "机制是什么", packet.question);
}

// --- 2. the caller cannot dictate the anchor ---------------------------
{
  // Passing a bogus pageIndex must not win over the content: when a selection is
  // supplied, the page is located from the text. Otherwise a UI showing page 9 would
  // attach every question to page 9.
  const packet = await service.askContext(scope, {
    paperId: "p1",
    question: "边界条件是什么",
    selectionText: "High workload weakens the servicescape effect",
    pageIndex: 0,
  });
  check("the page is derived from the passage, not from the caller's hint",
    packet.selection.pageIndex === 1, String(packet.selection.pageIndex));
}

// --- 3. an unlocatable selection is unanchored, not guessed ------------
{
  const packet = await service.askContext(scope, {
    paperId: "p1", question: "q", selectionText: "this sentence is not in the paper at all",
  });
  check("an unlocatable passage is reported as unanchored", packet.selection.anchored === false);
  check("an unlocatable passage gets charStart -1", packet.selection.charStart === -1,
    String(packet.selection.charStart));
  check("an unlocatable passage gets charEnd -1", packet.selection.charEnd === -1,
    String(packet.selection.charEnd));
  // -1 rather than 0 matters: 0 is a legitimate offset (a passage starting at the very
  // beginning), so using 0 as "unknown" would make the two indistinguishable.
  check("the unanchored sentinel is not a valid offset", packet.selection.charStart === -1);
}

// --- 4. whitespace differences do not break the anchor -----------------
{
  // Text-layer extraction produces soft line breaks; a browser selection carries them.
  // The stored page here has single spaces, so a selection with doubled spaces must
  // still be locatable — and, when whitespace differs, the anchor is reported honestly
  // rather than shifted.
  const withNewline = "The mechanism is customer engagement,\nwhich mediates the relationship.";
  const packet = await service.askContext(scope, { paperId: "p1", question: "q", selectionText: withNewline });
  // Either it locates exactly (the stored text contains the same words) or it reports
  // unanchored. What must never happen is a *wrong* offset that still claims anchored.
  if (packet.selection.anchored) {
    const sliced = store.getPageText("p1", packet.selection.pageIndex)
      .slice(packet.selection.charStart, packet.selection.charEnd);
    check("a located passage still slices back exactly", sliced === withNewline, JSON.stringify(sliced));
  } else {
    check("a passage that cannot be laid out verbatim is honestly unanchored", true);
  }
}

// --- 5. errors are named, not silent ----------------------------------
{
  const cases = [
    ["an unknown paper is refused", { paperId: "nope", question: "q" }, "paper-tool/paper-not-found"],
    ["an empty question is refused", { paperId: "p1", question: "   " }, "paper-tool/empty-question"],
    ["a missing question is refused", { paperId: "p1" }, "paper-tool/empty-question"],
  ];
  for (const [label, input, expected] of cases) {
    let code = null;
    try {
      await service.askContext(scope, input);
    } catch (error) {
      code = error.code ?? error.name;
    }
    check(label, code === expected, String(code));
  }
}

// --- 6. asking writes nothing -----------------------------------------
{
  const before = store.stats();
  await service.askContext(scope, { paperId: "p1", question: "q", selectionText: "customer engagement" });
  const after = store.stats();
  check("asking does not create evidence", before.evidence === after.evidence,
    `${before.evidence} -> ${after.evidence}`);
  check("asking does not create annotations", before.annotations === after.annotations,
    `${before.annotations} -> ${after.annotations}`);
  check("asking does not create a paper", before.papers === after.papers);
}

// --- 7. the answer can be written back as a note ----------------------
{
  const packet = await service.askContext(scope, {
    paperId: "p1", question: "机制是什么", selectionText: "customer engagement, which mediates",
  });
  const beforeAnnotations = store.countAnnotations();
  const saved = await service.saveAnswer(scope, {
    paperId: "p1",
    pageIndex: packet.selection.pageIndex,
    charStart: packet.selection.charStart,
    charEnd: packet.selection.charEnd,
    question: packet.question,
    answer: "机制是顾客参与的中介作用。",
    sourceQuote: packet.selection.text,
    kind: "note",
  });
  check("writing back as a note reports kind=note", saved.kind === "note", saved.kind);
  check("writing back as a note creates exactly one annotation",
    store.countAnnotations() === beforeAnnotations + 1,
    `${beforeAnnotations} -> ${store.countAnnotations()}`);
  const stored = store.getAnnotation(saved.annotationId);
  check("the saved note keeps the answer text", String(stored?.note).includes("中介作用"), String(stored?.note));
  check("the saved note keeps the question too", String(stored?.note).includes("机制是什么"), String(stored?.note));
  check("the saved note keeps the page anchor", stored?.pageIndex === packet.selection.pageIndex,
    String(stored?.pageIndex));
  check("the saved note keeps the character anchor", stored?.charStart === packet.selection.charStart,
    String(stored?.charStart));
  // The answer is the user's words; it must not be stored as the paper's words.
  check("the note is not stored as evidence", store.stats().evidence === 0,
    String(store.stats().evidence));
}

// --- 8. evidence write-back requires the paper's own words -------------
{
  const beforeEvidence = store.stats().evidence;
  let code = null;
  try {
    await service.saveAnswer(scope, {
      paperId: "p1", pageIndex: 0, answer: "随便一句", kind: "evidence",
    });
  } catch (error) {
    code = error.code ?? error.name;
  }
  check("saving an answer as evidence without a source quote is refused",
    code === "paper-tool/answer-has-no-quote", String(code));
  check("the refusal did not add evidence", store.stats().evidence === beforeEvidence,
    `${beforeEvidence} -> ${store.stats().evidence}`);

  const packet = await service.askContext(scope, {
    paperId: "p1", question: "机制是什么", selectionText: "customer engagement, which mediates",
  });
  const saved = await service.saveAnswer(scope, {
    paperId: "p1",
    pageIndex: packet.selection.pageIndex,
    charStart: packet.selection.charStart,
    charEnd: packet.selection.charEnd,
    question: packet.question,
    answer: "这说明参与度才是中介变量。",
    sourceQuote: packet.selection.text,
    kind: "evidence",
  });
  check("saving an answer as evidence with a quote succeeds", saved.kind === "evidence", saved.kind);
  check("the evidence count went up by one", store.stats().evidence === beforeEvidence + 1,
    `${beforeEvidence} -> ${store.stats().evidence}`);
  const rows = store.listEvidence({ paperId: "p1" });
  const row = rows[0];
  check("the evidence row holds the paper's words", row?.quote === packet.selection.text, String(row?.quote));
  check("the evidence row is anchored to the same page", row?.pageIndex === packet.selection.pageIndex,
    String(row?.pageIndex));
  // The answer itself lives in the annotation, not in the evidence quote — the two
  // tables must not converge or every answer inflates the support count.
  check("the answer is not mixed into the evidence quote",
    !String(row?.quote).includes("中介变量"), String(row?.quote));
}

// --- 9. asking twice about the same passage does not duplicate --------
{
  const packet = await service.askContext(scope, {
    paperId: "p1", question: "再问一次", selectionText: "customer engagement, which mediates",
  });
  const before = store.countAnnotations();
  const first = await service.saveAnswer(scope, {
    paperId: "p1", pageIndex: packet.selection.pageIndex,
    charStart: packet.selection.charStart, charEnd: packet.selection.charEnd,
    question: "问法一", answer: "答一", sourceQuote: packet.selection.text, kind: "note",
  });
  const second = await service.saveAnswer(scope, {
    paperId: "p1", pageIndex: packet.selection.pageIndex,
    charStart: packet.selection.charStart, charEnd: packet.selection.charEnd,
    question: "问法二", answer: "答二", sourceQuote: packet.selection.text, kind: "note",
  });
  check("saving the same anchor twice reuses the annotation id",
    first.annotationId === second.annotationId, `${first.annotationId} vs ${second.annotationId}`);
  check("saving the same anchor twice does not create a second row",
    store.countAnnotations() === before, `${before} -> ${store.countAnnotations()}`);
}

// --- 10. the client sends a packet, not a literal string ---------------
{
  const client = readFileSync("client.js", "utf8");
  // The old payload was a hand-composed Chinese string. It is gone; if it comes back,
  // the anchor is being built in the browser again and cannot be validated.
  for (const literal of ["【论文】", "【页码】", "【引文】", "【问题】"]) {
    check(`client.js no longer composes the "${literal}" literal`, !client.includes(literal));
  }
  check("the client calls askContext", /callRemote\(sessionId, "askContext"/.test(client));
  check("the client sends the selection text rather than a page guess",
    /askContext", \{\s*\n?\s*paperId: reader\.paperId,\s*\n?\s*question: text,\s*\n?\s*selectionText: selection\.text/.test(client));
  check("the client calls saveAnswer to write the answer back",
    /callRemote\(sessionId, "saveAnswer"/.test(client));
  check("the client distinguishes an unanchored packet in what it inserts",
    /packet\.selection\.anchored\s*\n?\s*\?/.test(client));
  // Both branches must actually differ. Grepping for the ternary alone is not enough:
  // a mutation that collapsed the two branches to the same string still matched the
  // pattern and passed — the gate was asserting the shape of the code, not its effect.
  check("the anchored branch states the character range",
    /askChars"\)\} \$\{packet\.selection\.charStart\}-\$\{packet\.selection\.charEnd\}/.test(client));
  check("the unanchored branch says the anchor was not found",
    /: `\$\{t\("askPage"\)\} \$\{packet\.selection\.pageIndex \+ 1\} · \$\{t\("askAnchorMissing"\)\}`/.test(client));
  check("the two branches are not the same text",
    !/anchored\s*\n?\s*\?\s*`\$\{t\("askPage"\)\} \$\{packet\.selection\.pageIndex \+ 1\}`\s*\n?\s*:\s*`\$\{t\("askPage"\)\} \$\{packet\.selection\.pageIndex \+ 1\}`/.test(client));
  // And the packet must say it out loud to the model, not only in the header line: an
  // unanchored passage must carry an explicit warning or the answer will cite a
  // location that was never verified.
  check("an unanchored packet carries an explicit warning line",
    /packet\.selection\.anchored\s*\n?\s*\?\s*""\s*\n?\s*:\s*`\[!\]/.test(client));
  check("the warning text is not empty", /askAnchorMissingHint: "[^"]{10,}"/.test(client));
  // The workspace is empty when the anchor failed, so the resolver must not fabricate
  // one: the keys exist in both dictionaries and are non-empty.
  check("the anchor-missing label is real text in both languages",
    (client.match(/askAnchorMissing: "[^"]{4,}"/g) ?? []).length === 2,
    String((client.match(/askAnchorMissing:/g) ?? []).length));
  check("the client remembers the packet so the answer can be written back",
    /setLastAsk\(packet\)/.test(client));
}

// --- 11. the tool surface did not grow (D-013/D-014) -------------------
{
  const tools = readFileSync("lib/tools.js", "utf8");
  const names = [...tools.matchAll(/name: "(paper_\w+)"/g)].map((m) => m[1]);
  check("still exactly six tools", names.length === 6, JSON.stringify(names));
  check("no paper_ask tool was added", !names.includes("paper_ask"));
  // The capability arrives as an action on paper_read instead.
  const readBlock = tools.slice(tools.indexOf('name: "paper_read"'), tools.indexOf('name: "paper_evidence"'));
  check("paper_read gained a context action", /enum: \["pages", "context"\]/.test(readBlock));
  check("the context action takes a question", /question: \{/.test(readBlock));
  check("the context action takes the selected text", /selectionText: \{/.test(readBlock));
  // The Host half must be registered as an RPC or the client call is unreachable.
  const host = readFileSync("lib/host-service.js", "utf8");
  const markRemoteBlock = host.slice(host.indexOf("for (const method of ["));
  check("askContext is registered as an RPC", markRemoteBlock.includes('"askContext"'));
  check("saveAnswer is registered as an RPC", markRemoteBlock.includes('"saveAnswer"'));
}

// --- 12. the plugin still holds no model channel (D-014) --------------
{
  const host = readFileSync("lib/host-service.js", "utf8");
  const tools = readFileSync("lib/tools.js", "utf8");
  const client = readFileSync("client.js", "utf8");
  const index = readFileSync("index.js", "utf8");
  // Strip comments before looking, because the code deliberately mentions these names
  // in comments explaining that they are absent — which is not the same as using them.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const [label, source] of [["host", host], ["tools", tools], ["client", client], ["index", index]]) {
    const code = stripComments(source);
    check(`${label} does not call a model`, !/ctx\.model|generateText\(|chatCompletion|streamText\(/.test(code));
  }
  check("inject still has no model service", !/inject\s*=\s*\[[^\]]*model/.test(index));
}

try {
  store.close?.();
} catch {
  /* already closed */
}
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

if (failures.length > 0) {
  console.log("\nINLINE-ASK FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nINLINE-ASK PASS");

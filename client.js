// Browser client for @local/paper-tool.
//
// One right-sidebar tab with three views: library, evidence, review. The tab
// never invents citations: it shows stored metadata, page-anchored evidence and
// CSL-rendered bibliographies, and hands prose writing to the chat model.
//
// Visual conventions that are load-bearing, not decorative:
//   * Every colour comes from a documented host alias token. An earlier version
//     used five variable names that do not exist in the host bundle, so every
//     `var()` silently fell back to a literal and the primary button became
//     invisible in dark mode. `test/wiring.mjs` now fails if a token is unknown.
//   * Surface pairs (`background` + `color`) are always set together through
//     `.pt-surface-*` classes, because setting one without the other is exactly
//     how content disappeared in dark mode.
//   * The sidebar is routinely 320-420px wide, so layout is driven by CSS
//     container queries, not by the viewport.
window.__ModuleLoader__.load({
  id: "@local/paper-tool",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useCallback, useEffect, useRef, useMemo } = React;

    const NS = "paperTool";
    const TAB_ID = "@local/paper-tool/library";
    const KIND = "paper-tool";

    // Bounds mirrored from the Host service. Duplicated here so the browser can
    // reject a file before reading it into memory; the Host still enforces them.
    const MAX_PDF_BYTES = 64 * 1024 * 1024;
    const MAX_QUOTE_CHARS = 500;
    const MAX_IMPORT_FILES = 32;

    const DICTS = {
      zh: {
        title: "论文",
        "guide.description": "导入 PDF、检索全文、按页码存证据，生成可回溯的引用与综述材料",
        library: "文献库",
        evidenceTab: "证据",
        reviewTab: "综述",
        papers: "篇",
        pagesLabel: "页",
        import: "导入 PDF",
        importing: "导入中…",
        searchPlaceholder: "搜索标题、摘要或全文…",
        search: "搜索",
        searching: "搜索中…",
        clear: "清空",
        empty: "库是空的。点「导入 PDF」把论文放进来。",
        emptyHint: "也可以先「外部检索」找条目，或连接知网下载。",
        noResults: "没有匹配结果。",
        noResultsHint: "换个词试试；中文支持任意长度，英文按整词匹配。",
        fulltext: "全文",
        ocrText: "扫描识别",
        ocrHint: "该 PDF 没有文本层，正文由 OCR 识别，个别字可能不准。",
        ocrQuoteHint: "此引文来自 OCR 文本，引用前建议对照原文页面核实。",
        // Metadata is recovered heuristically; these label what still needs a
        // human eye. A field the user edits stops being listed.
        guessBadge: "待核对：{fields}",
        guessHint: "这些字段是从 PDF 版面或文件名推测的，不是出版社写入的元数据，建议引用前确认。",
        reextract: "重新识别",
        reextractHint: "重新读取这篇 PDF 的书目信息。你已手动改过的字段不会被覆盖。",
        reextractDone: "已更新 {count} 个字段：{fields}",
        reextractNoChange: "重新识别完成，没有发现可更新的字段。",
        reextractDisagreed: "PDF 里的信息与已保存的 {fields} 不一致，但你没有标记为猜测，因此保留了原值。",
        enrich: "用 DOI 补全",
        enrichHint: "拿这篇的 DOI 去 Crossref 查权威元数据，补上缺失的作者和期刊。你手动改过的字段不会被覆盖；需要联网。",
        enrichDone: "已从 Crossref 补全 {count} 个字段：{fields}",
        enrichNoChange: "Crossref 没有带来新的字段。",
        enrichNoDoi: "这篇没有 DOI，无法反查。",
        enrichFailed: "查询失败：{reason}",
        crossrefBadge: "已核对 {fields}",
        crossrefHint: "这些字段是用 DOI 到 Crossref 查到的权威记录，不是从 PDF 版面猜的。",
        working: "处理中…",
        viewCrashed: "这个视图出错了",
        retry: "重试",
        fieldTitle: "标题",
        fieldAuthors: "作者",
        fieldYear: "年份",
        fieldVenue: "期刊",
        fieldDoi: "DOI",
        listSep: "、",
        metaOnly: "仅书目",
        noPdf: "无 PDF",
        sourceLine: "正文来源：{source}",
        sourceTextLayer: "PDF 文本层",
        sourceOcr: "OCR 识别，个别字可能不准",
        sourceNone: "没有正文，只有书目",
        page: "第",
        pages: "页",
        pageOf: "页",
        of: "/",
        reading: "阅读中",
        open: "阅读",
        closeReader: "返回列表",
        prevPage: "上一页",
        nextPage: "下一页",
        zoomIn: "放大",
        zoomOut: "缩小",
        fitWidth: "适宽",
        jump: "跳页",
        jumpPlaceholder: "页码",
        ask: "就这段提问",
        askPlaceholder: "就这段内容提问…",
        selected: "已选中",
        noSelection: "在 PDF 里选中文字后，可以提问或存为证据",
        askHint: "提问会带上论文、页码与引文",
  annotate: "划线",
  annotateNote: "笔记（可选）",
  annotationSaved: "已划线",
  annotationList: "标注",
  annotationNone: "这篇还没有标注",
  annotationNoQuote: "该标注没有选中原文，无法作为证据",
  annotationAnchorMissed: "标注已保存，但这段文字在页面上没找到（锚点可能已失效）",
  annotationDelete: "删除标注",
  annotationPromote: "转为证据",
  cancel: "取消",
  cancelBusy: "取消这个操作",
  cancelledByUser: "已取消（这是你主动停止的，不是出错）",
  busyStageImport: "正在导入",
  busyStageSearch: "正在检索",
  busyStageOcr: "正在识别文字",
  busyStageDownload: "正在下载",
  busyStageExport: "正在导出",
  cancelSkipped: "已取消，剩下 {n} 个未处理",
  askAnchor: "位置",
  askPage: "第",
  askChars: "字符",
  askSelection: "选段",
  askQuestion: "问题",
  askAnchorMissing: "未能在原文中定位",
  askAnchorMissingHint: "选段未能在该页原文中逐字找到，回答时不要声称确切位置。",
  answerEmpty: "请先粘贴或输入回答内容",
  answerSavedNote: "回答已存为笔记",
  answerSavedEvidence: "回答已存为证据",
  saveAnswerNote: "存为笔记",
  saveAnswerEvidence: "存为证据",
  answerPanelTitle: "回答回写",
  answerPlaceholder: "把回答粘贴到这里，再选择存为笔记或证据",
  reocr: "重跑 OCR",
  reocrHint: "这篇还没有可搜索的文本。重新识别会把扫描页转成可搜索文本。",
  reocrDone: "已识别 {pages} 页（{failed} 页失败）· 证据重新锚定 {moved} 条，失效 {lost} 条",
  reocrSkipped: "未执行：{reason}",
        askDefault: "请解释这段内容，并说明它与论文主题的关系。",
        delete: "删除",
        confirmDelete: "确认删除？",
        cancel: "取消",
        save: "保存",
        editMeta: "编辑元数据",
        titleLabel: "标题",
        authorsLabel: "作者（用分号分隔）",
        yearLabel: "年份",
        venueLabel: "期刊/会议",
        doiLabel: "DOI",
        abstractLabel: "摘要",
        evidence: "存为证据",
        evidenceSaved: "已存为证据",
        evidenceEmpty: "还没有证据。阅读时选中文字，或按主题收集。",
        evidenceEmptyHint: "证据 = 论文 + 页码 + 原文引文，导出时逐条可回溯。",
        evidenceAnchored: "已定位原文",
        evidenceUnanchored: "仅记录页码",
        evidenceUnanchoredHint: "这段引文没能在该页文本中定位，跳转只到页码。",
        quoteTooLong: "选中的文字超过 {limit} 字，请缩短后再存。",
        collect: "按主题收集",
        collectPlaceholder: "输入主题，例如：碳排放 影响因素",
        collectHint: "在全部已索引页里找相关句子，并保存为证据",
        matrix: "证据矩阵",
        claimPlaceholder: "输入一个论断，检查各论文的支持/冲突情况",
        checkStance: "检查支持度",
        coverage: "查看证据覆盖",
        support: "支持",
        conflict: "冲突",
        notFound: "未提及",
        noEvidenceStance: "无证据",
        covered: "有证据",
        emptyCoverage: "无证据",
        jumpToPage: "跳转",
        review: "综述材料",
        outline: "证据大纲",
        generateOutline: "生成大纲",
        citations: "引文",
        style: "引用样式",
        locale: "语言",
        generateCitations: "生成引用",
        bibliography: "参考文献",
        inText: "正文引用",
        export: "导出 .md + .bib",
        exporting: "导出中…",
        exported: "已导出",
        copy: "复制 Markdown",
        copied: "已复制",
        warnings: "核验提示",
        noWarnings: "作者与年份齐全",
        sendToChat: "送入对话",
        sentToChat: "已放入输入框，回车发送",
        external: "外部检索",
        externalSearch: "检索 OpenAlex / Crossref / arXiv",
        cnki: "知网",
        cnkiConnect: "连接知网",
        cnkiRecheck: "重新检测",
        cnkiConnected: "已登录",
        cnkiNotLoggedIn: "未登录",
        cnkiHint: "浏览器打开后手动登录一次，会话约保留 30 天。",
        cnkiConnecting: "正在打开浏览器…",
        cnkiSearch: "检索知网",
        addSelected: "加入文献库",
        added: "已加入",
        skipped: "已存在",
        downloading: "下载中…",
        noCandidates: "没有结果。",
        sourcesFailed: "部分来源失败",
        metadataOnlyNote: "外部条目只有书目，不是全文。",
        reload: "刷新",
        statusError: "连接失败",
        retry: "重试",
        confirm: "确认",
        back: "返回",
        total: "条命中",
        noEvidence: "还没有证据，无法生成引用。",
        selectEvidence: "引用默认使用全部证据。",
        evidenceCount: "条证据",
        paperCount: "篇文献",
        generatedAt: "生成时间",
        tooLarge: "文件超过 {limit} MB，请先压缩或拆分。",
        tooManyFiles: "一次最多导入 {limit} 个文件。",
        duplicates: "个已存在，已跳过",
        noPdfForPaper: "这篇只有书目，没有 PDF。",
        anchoredCount: "条可定位原文",
        textFallbackNote: "PDF 文本层无法叠加，改为显示抽取文本，仍可选中。",
        highlightMissed: "已打开对应页，但未在文本层中定位到该引文。",
        readerLoading: "正在加载 PDF…",
        pageCount: "共 {n} 页",
        searchScope: "检索范围",
        localLibrary: "本地库",
        statusLine: "{papers} 篇 · {pages} 页 · {evidence} 条证据",
        evidenceScopeHint: "共 {total} 条，本页显示 {shown} 条",
        filterAll: "全部",
        filterAnchored: "已定位",
        filterUnanchored: "仅页码",
        exportScope: "导出范围",
        exportAll: "全部证据",
        exportAnchored: "仅已定位",
        evidenceOnly: "仅已定位证据可导出（{n} 条）",
        unlocatedExcluded: "已排除 {n} 条仅记录页码的证据。",
        errorTitle: "出错了",
        dismiss: "知道了",
        selfCheck: "自检",
      },
      en: {
        title: "Papers",
        "guide.description": "Import PDFs, search full text, save page-anchored evidence, and produce traceable citations",
        library: "Library",
        evidenceTab: "Evidence",
        reviewTab: "Review",
        papers: "papers",
        pagesLabel: "pages",
        import: "Import PDF",
        importing: "Importing…",
        searchPlaceholder: "Search title, abstract or full text…",
        search: "Search",
        searching: "Searching…",
        clear: "Clear",
        empty: "Library is empty. Click “Import PDF” to add papers.",
        emptyHint: "Or use External search, or connect CNKI to download.",
        noResults: "No matches.",
        noResultsHint: "Try another term. CJK matches any length; English matches whole words.",
        fulltext: "full text",
        ocrText: "scanned OCR",
        ocrHint: "This PDF has no text layer; the text was recognised by OCR and individual characters may be wrong.",
        ocrQuoteHint: "This quote came from OCR text. Check it against the page image before citing it.",
        guessBadge: "Check: {fields}",
        guessHint: "These fields were inferred from the PDF layout or the file name, not written by the publisher. Confirm them before citing.",
        reextract: "Re-read metadata",
        reextractHint: "Re-extract the bibliographic details from this PDF. Fields you edited by hand are never overwritten.",
        reextractDone: "Updated {count} field(s): {fields}",
        reextractNoChange: "Re-extraction finished; nothing new to update.",
        reextractDisagreed: "The PDF disagrees with the saved {fields}, but you confirmed them, so the stored values were kept.",
        enrich: "Fill from DOI",
        enrichHint: "Look this paper's DOI up in Crossref to fill in missing authors and journal. Fields you edited by hand are never overwritten. Needs network.",
        enrichDone: "Filled {count} field(s) from Crossref: {fields}",
        enrichNoChange: "Crossref had nothing new for this paper.",
        enrichNoDoi: "This paper has no DOI, so there is nothing to look up.",
        enrichFailed: "Lookup failed: {reason}",
        crossrefBadge: "Verified {fields}",
        crossrefHint: "These fields were looked up in Crossref by DOI, not guessed from the PDF layout.",
        working: "Working…",
        viewCrashed: "This view hit an error",
        retry: "Try again",
        fieldTitle: "title",
        fieldAuthors: "authors",
        fieldYear: "year",
        fieldVenue: "journal",
        fieldDoi: "DOI",
        listSep: ", ",
        metaOnly: "metadata only",
        noPdf: "no PDF",
        sourceLine: "Text source: {source}",
        sourceTextLayer: "PDF text layer",
        sourceOcr: "OCR — individual characters may be wrong",
        sourceNone: "no body text, bibliography only",
        page: "Page",
        pages: "pages",
        pageOf: "page",
        of: "of",
        reading: "Reading",
        open: "Open",
        closeReader: "Back to list",
        prevPage: "Prev",
        nextPage: "Next",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        fitWidth: "Fit width",
        jump: "Go",
        jumpPlaceholder: "page",
        ask: "Ask about selection",
        askPlaceholder: "Ask about this passage…",
        selected: "Selected",
        noSelection: "Select text in the PDF to ask or save evidence",
        askHint: "The question carries paper, page and quote",
  annotate: "Highlight",
  annotateNote: "Note (optional)",
  annotationSaved: "Highlighted",
  annotationList: "Annotations",
  annotationNone: "No annotations for this paper yet",
  annotationNoQuote: "This annotation has no selected text, so it cannot become evidence",
  annotationAnchorMissed: "Saved, but the text was not found on the page (the anchor may have drifted)",
  annotationDelete: "Delete annotation",
  annotationPromote: "Promote to evidence",
  cancel: "Cancel",
  cancelBusy: "Cancel this operation",
  cancelledByUser: "Cancelled — you stopped this, it did not fail",
  busyStageImport: "Importing",
  busyStageSearch: "Searching",
  busyStageOcr: "Recognising text",
  busyStageDownload: "Downloading",
  busyStageExport: "Exporting",
  cancelSkipped: "Cancelled, {n} not processed",
  askAnchor: "anchor",
  askPage: "page",
  askChars: "chars",
  askSelection: "selection",
  askQuestion: "question",
  askAnchorMissing: "NOT located in the source",
  askAnchorMissingHint: "The selection was not found verbatim on that page. Do not claim an exact location for it.",
  answerEmpty: "Paste or type the answer first",
  answerSavedNote: "Answer saved as a note",
  answerSavedEvidence: "Answer saved as evidence",
  saveAnswerNote: "Save as note",
  saveAnswerEvidence: "Save as evidence",
  answerPanelTitle: "Write the answer back",
  answerPlaceholder: "Paste the answer here, then choose note or evidence",
  reocr: "Re-run OCR",
  reocrHint: "This paper has no searchable text yet. Re-running recognition turns the scanned pages into searchable text.",
  reocrDone: "Recognised {pages} page(s) ({failed} failed) · {moved} evidence row(s) re-anchored, {lost} no longer locatable",
  reocrSkipped: "Not run: {reason}",
        askDefault: "Explain this passage and its role in the paper.",
        delete: "Delete",
        confirmDelete: "Delete this paper?",
        cancel: "Cancel",
        save: "Save",
        editMeta: "Edit metadata",
        titleLabel: "Title",
        authorsLabel: "Authors (semicolon separated)",
        yearLabel: "Year",
        venueLabel: "Journal / venue",
        doiLabel: "DOI",
        abstractLabel: "Abstract",
        evidence: "Save as evidence",
        evidenceSaved: "Evidence saved",
        evidenceEmpty: "No evidence yet. Select text while reading, or collect by topic.",
        evidenceEmptyHint: "Evidence = paper + page + exact quote; every export traces back.",
        evidenceAnchored: "located in source",
        evidenceUnanchored: "page only",
        evidenceUnanchoredHint: "This quote could not be located in the page text, so jumps land on the page.",
        quoteTooLong: "Selection exceeds {limit} characters. Shorten it before saving.",
        collect: "Collect by topic",
        collectPlaceholder: "Topic, e.g. carbon emissions determinants",
        collectHint: "Find relevant sentences in indexed pages and store them",
        matrix: "Evidence matrix",
        claimPlaceholder: "Enter a claim to check support/conflict per paper",
        checkStance: "Check stance",
        coverage: "Coverage only",
        support: "support",
        conflict: "conflict",
        notFound: "not mentioned",
        noEvidenceStance: "no evidence",
        covered: "covered",
        emptyCoverage: "empty",
        jumpToPage: "Open",
        review: "Review material",
        outline: "Evidence outline",
        generateOutline: "Build outline",
        citations: "Citations",
        style: "Style",
        locale: "Locale",
        generateCitations: "Render citations",
        bibliography: "Bibliography",
        inText: "In-text citation",
        export: "Export .md + .bib",
        exporting: "Exporting…",
        exported: "Exported",
        copy: "Copy Markdown",
        copied: "Copied",
        warnings: "Checks",
        noWarnings: "Authors and years are complete",
        sendToChat: "Send to chat",
        sentToChat: "Inserted into the composer; press Enter",
        external: "External",
        externalSearch: "Search OpenAlex / Crossref / arXiv",
        cnki: "CNKI",
        cnkiConnect: "Connect CNKI",
        cnkiRecheck: "Re-check",
        cnkiConnected: "Logged in",
        cnkiNotLoggedIn: "Not logged in",
        cnkiHint: "Log in once in the browser window; the session lasts ~30 days.",
        cnkiConnecting: "Opening browser…",
        cnkiSearch: "Search CNKI",
        addSelected: "Add to library",
        added: "Added",
        skipped: "already present",
        downloading: "Downloading…",
        noCandidates: "No results.",
        sourcesFailed: "Some sources failed",
        metadataOnlyNote: "External entries are metadata only, not full text.",
        reload: "Refresh",
        statusError: "Connection failed",
        retry: "Retry",
        confirm: "Confirm",
        back: "Back",
        total: "hits",
        noEvidence: "No evidence yet; cannot render citations.",
        selectEvidence: "Citations use all evidence by default.",
        evidenceCount: "evidence",
        paperCount: "papers",
        generatedAt: "Generated",
        tooLarge: "File exceeds {limit} MB. Compress or split it first.",
        tooManyFiles: "At most {limit} files per import.",
        duplicates: "already present, skipped",
        noPdfForPaper: "This entry is metadata only; there is no PDF.",
        anchoredCount: "locatable in source",
        textFallbackNote: "The PDF text layer could not be overlaid; showing extracted text, still selectable.",
        highlightMissed: "Opened the page, but the quote was not found in the text layer.",
        readerLoading: "Loading PDF…",
        pageCount: "{n} pages",
        searchScope: "Search in",
        localLibrary: "Local library",
        statusLine: "{papers} papers · {pages} pages · {evidence} evidence",
        evidenceScopeHint: "{shown} of {total} shown",
        filterAll: "All",
        filterAnchored: "Located",
        filterUnanchored: "Page only",
        exportScope: "Export scope",
        exportAll: "All evidence",
        exportAnchored: "Located only",
        evidenceOnly: "Only located evidence can be exported ({n}).",
        unlocatedExcluded: "{n} page-only evidence row(s) excluded.",
        errorTitle: "Something went wrong",
        dismiss: "Dismiss",
        selfCheck: "Self-check",
      },
    };

    let sharedCtx = null;

    // Source-mode Remote descriptors flatten method parameters into wire
    // fields. Every business method here takes one `input` object, so the
    // client must send `{ input: {...} }` rather than spreading its keys.
    const INPUT_METHODS = new Set([
      "importPdf", "updatePaper", "listPapers", "search", "readPaper",
      "getPdfAsset", "readPaperBytes", "deletePaper", "addEvidence",
      "deleteEvidence", "collectEvidence", "listEvidence", "reviewMatrix",
      "reviewOutline", "formatCitations", "exportReview", "searchExternal",
      "addCandidates", "cnkiSearch", "cnkiDownload",
      "reextractMetadata", "enrichMetadata",
      "ocrPaper",
      // askContext and saveAnswer take an `input` object like the rest, so they must be
      // listed here; the wiring gate checks both sides agree.
      "askContext", "saveAnswer",
    ]);

    /** Typed transport failure. `code` drives the recovery the UI offers. */
    class RpcError extends Error {
      constructor(message, code, details) {
        super(message);
        this.name = "RpcError";
        this.code = code ?? "unknown";
        this.details = details ?? null;
      }
    }

    async function callRemote(sessionId, method, args = {}, signal) {
      const payload = INPUT_METHODS.has(method)
        ? { paperSessionId: sessionId, input: args }
        : { paperSessionId: sessionId, ...args };
      const envelope = await sharedCtx.connection.rpc.call(
        "/api",
        `paperTool/${method}`,
        { args: payload },
        signal,
      );
      if (envelope && envelope.ok === false) {
        // The host classifies failures (paper-tool/paper-not-found,
        // paper-tool/too-large, …). Dropping the code here would collapse
        // "this paper was deleted" and "the gateway is down" into one message.
        throw new RpcError(
          envelope.error?.message ?? "rpc failed",
          envelope.error?.code,
          envelope.error?.details,
        );
      }
      return envelope?.ok === true ? envelope.value : envelope;
    }

    /** Human-readable, in-language message for a typed transport failure. */
    /**
 * Whether an error is the user cancelling rather than something going wrong.
 *
 * Kept separate from `describeError` because the two need different treatment: a
 * failure belongs in a red banner, a cancellation belongs in a neutral one. Feeding
 * an AbortError to describeError prints "AbortError: The operation was aborted", which
 * reads to the user as a crash they did not cause.
 */
function isAbortError(error) {
  if (error === null || typeof error !== "object") return false;
  return error.name === "AbortError" || error.code === "ABORT_ERR";
}

function describeError(error, t) {
      if (error === null || error === undefined) return "";
      if (error instanceof RpcError) {
        if (error.code === "paper-tool/paper-not-found") return t("noPdfForPaper");
        if (error.code === "paper-tool/quote-too-long") {
          const limit = error.details?.limit ?? MAX_QUOTE_CHARS;
          return t("quoteTooLong", { limit });
        }
        if (error.code === "paper-tool/too-large") {
          const limit = Math.round((error.details?.limit ?? MAX_PDF_BYTES) / 1024 / 1024);
          return t("tooLarge", { limit });
        }
        if (error.code === "paper-tool/too-many-files") {
          return t("tooManyFiles", { limit: error.details?.limit ?? MAX_IMPORT_FILES });
        }
        return error.message;
      }
      return error?.message ?? String(error);
    }

    /**
     * Which surfaces a piece of text lives on.
     *
     * Set as a pair, always. The previous version set `background` on <pre>
     * without setting `color`, which inherited the host's near-white body text
     * and rendered white-on-white in dark mode — the outline, the in-text
     * citation and the whole bibliography became invisible.
     */
    const CSS = `
      .pt-root {
        box-sizing: border-box; height: 100%; min-height: 100%;
        display: flex; flex-direction: column;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 13px; line-height: 20px;
        container-type: inline-size; container-name: pt;
      }
      .pt-root *, .pt-root *::before, .pt-root *::after { box-sizing: border-box; }

      /* Typography: one family (inherited), deliberate scale.
         Contrast budget, measured against the resolved host values:
           label-primary   light 18.90:1 / dark 15.03:1  — passes AA
           label-secondary light  5.80:1 / dark 10.42:1  — passes AA
           label-tertiary  light  3.71:1 / dark  7.36:1  — fails AA below 18px
           label-caption   light  2.13:1 / dark  4.24:1  — fails AA below 18px
         So text that carries information at 11-12px must be secondary or
         better; hierarchy comes from size, weight and spacing rather than from
         fading text out. tertiary is kept for non-text strokes (field rules,
         hairlines) and caption for decorative separators only. */
      .pt-h1 { font-size: 14px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .pt-h2 { font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .pt-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .pt-caption { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
      .pt-body { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
      .pt-num { font-variant-numeric: tabular-nums; }

      /* Surfaces. Background and foreground are decided together. */
      .pt-surface-1 { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .pt-surface-2 { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .pt-surface-3 { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); }
      .pt-well {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-md);
      }
      .pt-pre {
        margin: 0; padding: 8px 10px; max-height: 34vh; overflow: auto;
        white-space: pre-wrap; word-break: break-word; user-select: text;
        font-family: inherit; font-size: 12px; line-height: 18px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-md);
      }

      /* Reader annotations, painted as <mark> over the PDF text layer.
         Colours are deliberately low-alpha: the text layer sits on top of the
         rendered page, so an opaque background would hide the very glyphs the
         highlight is meant to point at. */
      .pt-annotation {
        background: rgba(250, 204, 21, 0.42);
        color: inherit;
        border-radius: 2px;
        box-shadow: 0 0 0 1px rgba(250, 204, 21, 0.55);
        cursor: help;
      }
      .pt-annotation[data-color="green"] {
        background: rgba(74, 222, 128, 0.38);
        box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.55);
      }
      .pt-annotation[data-color="blue"] {
        background: rgba(96, 165, 250, 0.38);
        box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.55);
      }
      .pt-annotation[data-color="pink"] {
        background: rgba(244, 114, 182, 0.38);
        box-shadow: 0 0 0 1px rgba(244, 114, 182, 0.55);
      }

      /* Buttons: every one is a real <button> with a visible focus ring. */
      .pt-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 4px;
        min-height: 28px; padding: 3px 10px;
        font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap;
        color: var(--dsw-alias-label-secondary);
        background: transparent;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-sm);
        cursor: pointer;
      }
      .pt-btn:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover-accent);
        color: var(--dsw-alias-label-primary);
      }
      .pt-btn:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 1px;
      }
      .pt-btn:disabled { opacity: .45; cursor: default; }
      .pt-btn-primary {
        color: var(--dsw-alias-label-primary);
        border-color: var(--dsw-alias-brand-primary);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
      }
      .pt-btn-primary:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
      }
      .pt-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .pt-btn-danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
        color: var(--dsw-alias-state-error-primary);
      }
      .pt-btn-ghost { border-color: transparent; color: var(--dsw-alias-label-tertiary); }
      .pt-btn-icon { padding: 3px 6px; min-width: 28px; }

      /* Inputs. */
      .pt-input, .pt-select, .pt-textarea {
        width: 100%; min-width: 0; min-height: 28px; padding: 3px 8px;
        font: inherit; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-sm);
      }
      .pt-textarea { min-height: 64px; resize: vertical; line-height: 19px; }
      .pt-input::placeholder, .pt-textarea::placeholder { color: var(--dsw-alias-label-caption); }
      .pt-input:focus-visible, .pt-select:focus-visible, .pt-textarea:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: -1px;
        border-color: var(--dsw-alias-brand-primary);
      }

      /* Tabs: an underline rule, not a row of buttons that all look primary. */
      .pt-tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .pt-tab {
        position: relative; flex: 1 1 0; min-width: 0; min-height: 34px; padding: 6px 2px;
        font: inherit; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-tertiary); background: none; border: 0; cursor: pointer;
      }
      .pt-tab:hover { color: var(--dsw-alias-label-primary); }
      .pt-tab:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
      .pt-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); font-weight: 600; }
      .pt-tab[aria-selected="true"]::after {
        content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px;
        background: var(--dsw-alias-brand-primary); border-radius: 2px;
      }
      .pt-tab-count { color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; font-weight: 400; }

      /* Cards. */
      .pt-card {
        padding: 9px 10px; border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        color: var(--dsw-alias-label-primary);
      }
      .pt-card:hover { border-color: var(--dsw-alias-border-l2); }
      .pt-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
      .pt-divider { height: 1px; background: var(--dsw-alias-border-l1); border: 0; margin: 0; }

      /* Badges. Small labels stay at 11px so they keep 4.5:1 contrast; the old
         0.72em (9.4px) + opacity .85 landed support at 2.8:1. */
      .pt-badge {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 0 6px; height: 18px; white-space: nowrap;
        font-size: 11px; line-height: 16px; font-weight: 500;
        color: var(--dsw-alias-label-tertiary);
        background: transparent;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-xs);
      }
      .pt-badge-support { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-secondary); }
      .pt-badge-conflict { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-secondary); }
      .pt-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .pt-badge-info { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-border-l2); }
      .pt-badge-quiet { color: var(--dsw-alias-label-caption); border-color: transparent; }

      /* Messages. */
      .pt-banner {
        display: flex; gap: 8px; align-items: flex-start;
        padding: 8px 10px; font-size: 12px; line-height: 18px;
        border-radius: var(--dsw-radius-md);
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
      }
      .pt-banner-error {
        border-color: var(--dsw-alias-state-error-secondary);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-1));
      }
      .pt-banner-note { color: var(--dsw-alias-label-secondary); }

      /* Empty states are an instruction, not a mood. */
      .pt-empty { padding: 24px 12px; text-align: center; }
      .pt-empty-title { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .pt-empty-hint { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }

      /* Toolbar: wraps by priority, never overflows. */
      .pt-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .pt-toolbar-grow { flex: 1 1 140px; min-width: 0; }
      .pt-spacer { flex: 1 1 auto; }

      /* Reader */
      .pt-reader { display: flex; flex-direction: column; gap: 6px; flex: 1 1 auto; min-height: 0; }
      .pt-reader-bar {
        display: flex; gap: 4px; align-items: center; flex-wrap: wrap;
        padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .pt-canvas-wrap {
        flex: 1 1 auto; min-height: 180px; max-height: 62vh; overflow: auto;
        display: flex; justify-content: center; align-items: flex-start;
        padding: 8px;
        background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-md);
      }
      .pt-page { position: relative; flex: none; }
      .pt-textLayer {
        position: absolute; inset: 0; overflow: hidden; opacity: 1;
        line-height: 1; text-align: initial; text-size-adjust: none;
        forced-color-adjust: none; transform-origin: 0 0; z-index: 2;
        --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
        --min-font-size-inv: calc(1 / var(--min-font-size));
      }
      .pt-textLayer span, .pt-textLayer br {
        color: transparent; position: absolute; white-space: pre;
        cursor: text; transform-origin: 0% 0%;
        font-size: calc(var(--text-scale-factor) * var(--font-height));
        --scale-x: 1; --rotate: 0deg;
        transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
      }
      .pt-textLayer .markedContent { display: contents; }
      .pt-textLayer ::selection { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); }
      .pt-textLayer .pt-hit { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }

      .pt-snippet mark {
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent);
        color: var(--dsw-alias-label-primary);
        border-radius: 2px;
      }

      /* Row layouts collapse before they squeeze. */
      .pt-row { display: flex; gap: 8px; align-items: flex-start; }
      .pt-row-main { flex: 1 1 auto; min-width: 0; }
      .pt-row-aside { flex: none; display: flex; gap: 4px; align-items: center; }

      @container pt (max-width: 340px) {
        .pt-btn-label { display: none; }
        .pt-btn { padding: 3px 7px; }
        .pt-tab { font-size: 11px; }
        .pt-row-aside { flex-direction: column; align-items: stretch; }
      }
    `;

    let cssInjected = false;
    function ensureCss() {
      if (cssInjected || typeof document === "undefined") return;
      if (document.querySelector("style[data-paper-tool-style]") === null) {
        const style = document.createElement("style");
        style.dataset.paperToolStyle = "1";
        style.textContent = CSS;
        document.head.appendChild(style);
      }
      cssInjected = true;
    }

    /**
     * Which bibliographic fields are still unverified guesses.
     *
     * The Host stores `metadataSource` as a JSON object of field → provenance
     * ("xmp", "info", "subject", "filename", "layout", "page-text"). A field
     * present there was recovered heuristically; a field the user edited is
     * removed from it. So the set difference is exactly "please check this".
     *
     * An unparseable value must not make the card look verified: the honest
     * fallback is to assume nothing is confirmed, because the alternative is
     * presenting a guess as a fact.
     */
    function guessedFields(paper) {
      const known = ["title", "authors", "year", "venue", "doi"];
      const raw = paper?.metadataSource;
      // No provenance at all means the row predates v4 or was never imported
      // through the extractor; either way we cannot claim it was checked.
      if (typeof raw !== "string" || raw.trim() === "") return [];
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      if (parsed === null || typeof parsed !== "object") return [];
      return known.filter((field) => {
        const source = parsed[field];
        if (typeof source !== "string" || source === "") return false;
        // Only values that are actually present can be doubted.
        const value = typeof paper[field] === "string" ? paper[field].trim() : "";
        if (value === "") return false;
        // A high-confidence source is not a guess. XMP came from the file itself,
        // and `info`/`subject` were written by the publisher.
        return source === "layout" || source === "filename" || source === "page-text";
      });
    }

    /**
     * Fields whose value came from Crossref: confirmed, not guessed.
     *
     * Kept separate from `guessedFields` rather than folded into it because the two
     * badges answer different questions — "this might be wrong" versus "this was
     * checked against the authoritative record". A value can only be one of them.
     */
    function crossrefFields(paper) {
      const known = ["title", "authors", "year", "venue", "doi"];
      const raw = paper?.metadataSource;
      if (typeof raw !== "string" || raw.trim() === "") return [];
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      if (parsed === null || typeof parsed !== "object") return [];
      return known.filter((field) => {
        if (parsed[field] !== "crossref") return false;
        const value = typeof paper[field] === "string" ? paper[field].trim() : "";
        return value !== "";
      });
    }

    /** Dictionary key for a field name, used in the "guessed" badge. */
    function fieldLabelKey(field) {
      switch (field) {
        case "title": return "fieldTitle";
        case "authors": return "fieldAuthors";
        case "year": return "fieldYear";
        case "venue": return "fieldVenue";
        case "doi": return "fieldDoi";
        default: return field;
      }
    }

    /**
     * Turn a search snippet into React nodes, marking the bracketed hits.
     *
     * The Host brackets matches with [..]. Building elements directly means PDF
     * text never becomes markup, so no escaping step can be got wrong and no
     * raw-HTML injection point exists in this file.
     */
    function snippetNodes(text) {
      const value = String(text ?? "");
      const parts = [];
      let last = 0;
      for (const match of value.matchAll(/\[([^\]]*)\]/g)) {
        if (match.index > last) parts.push(value.slice(last, match.index));
        parts.push(h("mark", { key: `m${match.index}` }, match[1]));
        last = match.index + match[0].length;
      }
      if (last < value.length) parts.push(value.slice(last));
      return parts.length === 0 ? value : parts;
    }

    function normalizeSelection(text) {
      const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
      // A text layer splits CJK runs into per-glyph spans; joining them with
      // spaces would corrupt the stored quote and the page-text anchor.
      return collapsed.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
    }

    /**
     * Select a stored quote inside the rendered text layer.
     *
     * A real DOM selection is used instead of wrapping spans: the text layer is
     * recreated on every page/zoom change, and mutating its nodes would fight
     * PDF.js. Whitespace is ignored because spans split lines differently.
     */
    function highlightInLayer(container, quote) {
      const needle = String(quote ?? "").replace(/\s+/g, "");
      if (needle === "") return false;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const map = [];
      const compact = [];
      let node = walker.nextNode();
      while (node !== null) {
        const text = node.nodeValue ?? "";
        for (let offset = 0; offset < text.length; offset += 1) {
          const char = text[offset];
          if (!/\s/.test(char)) {
            compact.push(char);
            map.push({ node, offset });
          }
        }
        node = walker.nextNode();
      }
      const haystack = compact.join("");
      const at = haystack.indexOf(needle.slice(0, 160));
      if (at < 0) return false;
      const start = map[at];
      const end = map[at + Math.min(needle.length, 160) - 1];
      if (!start || !end) return false;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }

    /**
     * Paint persisted annotations onto a freshly rendered text layer.
     *
     * Unlike `highlightInLayer`, this does NOT use a DOM selection: a selection is
     * one global range, it is wiped by the next click or page turn, and it cannot
     * show more than one highlight at a time. Annotations are permanent marks, so
     * they are rendered as `<mark>` elements wrapping the matched text runs.
     *
     * Mutating the text layer's nodes is safe here only because this runs after
     * `textLayer.render()` has finished and the layer is discarded on the next
     * page/zoom change — the wrapper never has to survive a PDF.js re-render. That
     * is also why the painter is called from the same place that renders, and not
     * from an effect that could fire while PDF.js is mid-build.
     *
     * @returns {number} how many of the given annotations were located on this page
     */
    function paintHighlights(container, annotations) {
      if (!Array.isArray(annotations) || annotations.length === 0) return 0;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      // Same whitespace-insensitive mapping as highlightInLayer: the text layer
      // splits lines and CJK glyphs into separate spans, so a stored quote and the
      // concatenated text nodes rarely match character for character.
      const map = [];
      const compact = [];
      let node = walker.nextNode();
      while (node !== null) {
        const text = node.nodeValue ?? "";
        for (let offset = 0; offset < text.length; offset += 1) {
          const char = text[offset];
          if (!/\s/.test(char)) {
            compact.push(char);
            map.push({ node, offset });
          }
        }
        node = walker.nextNode();
      }
      const haystack = compact.join("");
      if (haystack === "") return 0;

      // Collect non-overlapping ranges first, then paint in reverse document order:
      // wrapping a later range does not disturb the offsets of an earlier one, while
      // painting forward would invalidate every already-computed node reference.
      const ranges = [];
      for (const annotation of annotations) {
        const needle = String(annotation?.quote ?? "").replace(/\s+/g, "");
        // Keep this even though removing it changes nothing observable: an empty
        // needle makes `indexOf("")` return 0 and the resulting zero-length range
        // paints no mark anyway (proved with a mutation test, which could not detect
        // its removal). It stays because the intent — "a note-only annotation is not
        // a highlight" — should not have to be re-derived from range arithmetic by
        // the next reader, and because a future change to the zero-length case would
        // otherwise silently turn every note into a mark at the page start.
        if (needle === "") continue;
        const at = haystack.indexOf(needle.slice(0, 160));
        if (at < 0) continue;
        if (ranges.some((r) => at < r.end && at + needle.length > r.start)) continue;
        ranges.push({ start: at, end: at + Math.min(needle.length, 160), annotation });
      }
      if (ranges.length === 0) return 0;
      ranges.sort((a, b) => b.start - a.start);
      let painted = 0;
      for (const range of ranges) {
        // A quote routinely spans more than one PDF.js text node: the layer emits one
        // node per line, and a highlighted sentence crosses lines. `surroundContents`
        // cannot wrap a cross-node range at all (it throws), so the range is split
        // into one mark per text node it covers. The result is several adjacent marks
        // that read as one continuous highlight, which is what the reader sees.
        const touched = [];
        for (let index = range.start; index < range.end; index += 1) {
          const point = map[index];
          if (point === undefined) continue;
          const last = touched[touched.length - 1];
          if (last !== undefined && last.node === point.node) {
            last.end = point.offset;
          } else {
            touched.push({ node: point.node, start: point.offset, end: point.offset });
          }
        }
        let wrappedAny = false;
        for (const piece of touched) {
          try {
            const domRange = document.createRange();
            domRange.setStart(piece.node, piece.start);
            domRange.setEnd(piece.node, piece.end + 1);
            const mark = document.createElement("mark");
            mark.className = "pt-annotation";
            mark.dataset.annotationId = String(range.annotation.annotationId ?? "");
            mark.dataset.color = String(range.annotation.color ?? "yellow");
            if (typeof range.annotation.note === "string" && range.annotation.note !== "") {
              mark.title = range.annotation.note;
            }
            domRange.surroundContents(mark);
            wrappedAny = true;
          } catch {
            // A node that cannot be wrapped is skipped rather than aborting the
            // annotation: a quote spanning a page break should still highlight the
            // part that is on this page.
          }
        }
        if (wrappedAny) painted += 1;
      }
      return painted;
    }

    /**
     * Load the pdfjs runtime once per page and keep its Blob URLs for the
     * lifetime of the module, revoking them only if the module is torn down.
     * The previous version rebuilt them per session id and never released the
     * PDFDocumentProxy, so every opened paper leaked a worker and its fonts.
     */
    const pdfjsCache = new Map();
    async function loadPdfjs(sessionId) {
      const cached = pdfjsCache.get(sessionId);
      if (cached !== undefined) return cached;
      const runtime = await callRemote(sessionId, "getPdfRuntime");
      const mainUrl = URL.createObjectURL(new Blob([runtime.pdfMainSource], { type: "text/javascript" }));
      const workerUrl = URL.createObjectURL(new Blob([runtime.pdfWorkerSource], { type: "text/javascript" }));
      const pdfjs = await import(mainUrl);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const entry = { pdfjs, workerUrl, mainUrl };
      pdfjsCache.set(sessionId, entry);
      return entry;
    }

    /** Serve CMaps and standard fonts from the Host; required for CJK PDFs. */
    function makeAssetFactory(pdfjs, sessionId) {
      const cache = new Map();
      const CMAP_BASE = "paper-tool:cmaps/";
      const FONT_BASE = "paper-tool:fonts/";
      const load = async (kind, name) => {
        const key = `${kind}/${name}`;
        if (cache.has(key)) return cache.get(key);
        const asset = await callRemote(sessionId, "getPdfAsset", { kind, name });
        const bytes = new Uint8Array(asset.data);
        cache.set(key, bytes);
        return bytes;
      };

      // pdfjs's DOMBinaryDataFactory is internal (not exported from the main
      // build), so implement the small public contract it consumes instead of
      // extending an undefined symbol. `fetch` is called by the document
      // transport; `_fetch` maps the fake base URL back to a Host RPC.
      class HostBinaryDataFactory {
        constructor({ cMapUrl = null, standardFontDataUrl = null, wasmUrl = null } = {}) {
          this.cMapUrl = cMapUrl;
          this.standardFontDataUrl = standardFontDataUrl;
          this.wasmUrl = wasmUrl;
        }
        async fetch({ kind, filename }) {
          const base = this[kind];
          if (!base) throw new Error(`missing ${kind} base URL`);
          return await this._fetch(`${base}${filename}`, kind);
        }
        async _fetch(url, kind) {
          if (kind === "cMapUrl") return await load("cmaps", url.slice(CMAP_BASE.length));
          if (kind === "standardFontDataUrl") return await load("standard_fonts", url.slice(FONT_BASE.length));
          throw new Error(`unsupported binary asset: ${kind}`);
        }
      }

      return {
        BinaryDataFactory: HostBinaryDataFactory,
        cMapUrl: CMAP_BASE,
        standardFontDataUrl: FONT_BASE,
      };
    }

    /**
     * Release a PDF document and its worker.
     *
     * PDF.js 6 exposes `loadingTask.destroy()` and `document.cleanup()`; the
     * document proxy has NO `destroy()`. This code used to call `doc.destroy()`
     * in both teardown paths, so closing the reader threw
     * "doc.destroy is not a function" — which is exactly what the user saw when
     * pressing 「返回列表」.
     *
     * Every call is guarded on `typeof … === "function"`: a defensive check here
     * is not cargo-culting, because the API genuinely differs across PDF.js
     * majors and a teardown path that throws takes down the whole view.
     */
    function releasePdfDocument(loadingTask, doc) {
      const attempt = (label, run) => {
        try {
          const result = run();
          if (result && typeof result.catch === "function") result.catch(() => {});
        } catch {
          // Teardown must never throw: it runs while React is unmounting, and an
          // exception here surfaces as a blank pane.
          void label;
        }
      };
      if (loadingTask && typeof loadingTask.destroy === "function") {
        attempt("loadingTask.destroy", () => loadingTask.destroy());
      } else if (doc && typeof doc.cleanup === "function") {
        // No task to destroy; at least drop the cached page/font data.
        attempt("doc.cleanup", () => doc.cleanup());
      }
    }

    // --- primitives -------------------------------------------------------

    function Badge({ tone, children, title }) {
      return h("span", {
        className: `pt-badge${tone ? ` pt-badge-${tone}` : ""}`,
        title,
      }, children);
    }

    function Button({ children, onClick, variant, disabled, title, label, icon }) {
      const cls = `pt-btn${variant === "primary" ? " pt-btn-primary" : variant === "danger" ? " pt-btn-danger" : variant === "ghost" ? " pt-btn-ghost" : ""}${icon ? " pt-btn-icon" : ""}`;
      return h("button", {
        type: "button", className: cls, onClick, disabled, title: title ?? label,
        "aria-label": icon && label ? label : undefined,
      }, children);
    }

    function Empty({ title, hint, action }) {
      return h("div", { className: "pt-empty" },
        h("div", { className: "pt-empty-title" }, title),
        hint ? h("div", { className: "pt-empty-hint" }, hint) : null,
        action ? h("div", { style: { marginTop: 10 } }, action) : null,
      );
    }

    /**
     * Keep one broken view from taking the whole pane with it.
     *
     * The sidebar is a single React tree with no boundary above it, so any throw
     * during render, or in a lifecycle method, unmounted the entire plugin and
     * left the user with a blank pane and no way back except a reload. An error
     * in the PDF reader is the most likely trigger, because it is the only view
     * that drives a worker and a canvas.
     *
     * The fallback deliberately offers a reset: a stuck reader usually recovers
     * once its subtree is thrown away and remounted, and forcing the user to
     * reload the whole app for that is not acceptable.
     */
    class ViewBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        // Keep the detail in the console: the message shown in the pane has to
        // stay short and translated, but a stack is what makes a report useful.
        console.error("paper-tool view crashed:", error, info?.componentStack ?? "");
      }
      render() {
        if (this.state.error !== null) {
          return h("div", { style: { padding: "10px 12px" } },
            h(Banner, { tone: "error", title: this.props.t("viewCrashed") },
              `${this.state.error.message ?? String(this.state.error)}`),
            h("div", { style: { marginTop: 8 } },
              h(Button, {
                variant: "primary",
                onClick: () => this.setState({ error: null }),
              }, this.props.t("retry"))));
        }
        return this.props.children;
      }
    }

    function Banner({ tone, title, children, onDismiss, dismissLabel }) {
      return h("div", {
        className: `pt-banner${tone === "error" ? " pt-banner-error" : " pt-banner-note"}`,
        role: tone === "error" ? "alert" : "status",
      },
        h("div", { className: "pt-row-main" },
          title ? h("div", { style: { fontWeight: 600 } }, title) : null,
          h("div", { style: title ? { marginTop: 2 } : null }, children),
        ),
        onDismiss ? h(Button, { variant: "ghost", onClick: onDismiss, label: dismissLabel }, "✕") : null,
      );
    }

    // --- library ----------------------------------------------------------

    function PaperCard({ paper, t, onOpen, onEdit, onReextract, onEnrich, onReocr, onDelete, busy }) {
      // Three states, three different claims. Folding OCR into "full text"
      // would present guessed characters as if they were the PDF's own text,
      // and folding it into "metadata only" would deny that the paper is
      // searchable at all.
      const isFulltext = paper.material === "fulltext";
      const isOcr = paper.material === "ocr";
      const materialLabel = isFulltext ? t("fulltext") : isOcr ? t("ocrText") : t("metaOnly");
      const hasPdf = typeof paper.pdfPath === "string" && paper.pdfPath !== "";
      const hasDoi = typeof paper.doi === "string" && paper.doi.trim() !== "";
      const [confirming, setConfirming] = useState(false);
      // Outcome of the last re-extraction, shown next to the buttons that caused
      // it. A silent success would leave the user unsure whether the repaired
      // fields are actually new.
      const [reextractResult, setReextractResult] = useState(null);
      // Same "tell me what actually moved" contract as re-extraction: the user
      // pressed a button to repair citations, so silence would leave them unsure
      // whether the bibliographic fields are now trustworthy.
      const [enrichResult, setEnrichResult] = useState(null);
      // A re-run of OCR changes the paper's material and can move existing anchors, so it
      // reports numbers rather than just "done" — especially the anchors it lost track of,
      // which the user would otherwise only notice when a quote stopped highlighting.
      const [reocrResult, setReocrResult] = useState(null);
      const meta = [paper.authors, paper.year, paper.venue].filter(Boolean).join(" · ");
      // Which fields are still guesses. `metadataSource` records where each value
      // came from; a user correction removes its entry, so this list shrinks as
      // the bibliography is checked. Showing it on the card is the difference
      // between "the app claims this is the journal" and "the app is asking".
      const guessed = guessedFields(paper);
      const fromCrossref = crossrefFields(paper);
      return h("li", { className: "pt-card" },
        h("div", { className: "pt-row" },
          h("div", { className: "pt-row-main" },
            h("div", { style: { display: "flex", gap: 6, alignItems: "baseline" } },
              h("span", {
                className: "pt-h2",
                style: { flex: 1, minWidth: 0, fontWeight: 600, color: "var(--dsw-alias-label-primary)", wordBreak: "break-word" },
              }, paper.title || "(untitled)"),
            ),
            meta ? h("div", { className: "pt-meta", style: { marginTop: 2, wordBreak: "break-word" } }, meta) : null,
            h("div", { style: { display: "flex", gap: 4, alignItems: "center", marginTop: 4, flexWrap: "wrap" } },
              h(Badge, { tone: isFulltext ? "info" : isOcr ? "warn" : undefined, title: isOcr ? t("ocrHint") : undefined }, materialLabel),
              hasPdf ? null : h(Badge, { tone: "quiet" }, t("noPdf")),
              guessed.length > 0
                ? h(Badge, { tone: "warn", title: t("guessHint") }, t("guessBadge", { fields: guessed.map((field) => t(fieldLabelKey(field))).join(t("listSep")) }))
                : null,
              // A field filled from Crossref is not a guess — it was confirmed
              // against the publisher's own record for that DOI. Saying so is the
              // point of keeping per-field provenance: the user can trust those
              // values without re-checking them by hand.
              fromCrossref.length > 0
                ? h(Badge, { tone: "info", title: t("crossrefHint") }, t("crossrefBadge", { fields: fromCrossref.map((field) => t(fieldLabelKey(field))).join(t("listSep")) }))
                : null,
              h("span", { className: "pt-caption pt-num" },
                `${paper.numPages || 0} ${t("pages")}${paper.hitCount > 1 ? ` · ${paper.hitCount} ${t("total")}` : ""}`),
            ),
            // Where the readable text came from, in words rather than a glyph.
            // The OCR badge above says "scanned", but the consequence — that
            // quotes taken from it may carry misread characters — is what the
            // user needs before citing, and a title tooltip needs a hover to
            // discover. This line is always visible. The label goes through the
            // dictionary with a placeholder so the colon is localised too.
            h("div", { className: "pt-caption", style: { marginTop: 3 } },
              t("sourceLine", {
                source: isOcr ? t("sourceOcr") : isFulltext ? t("sourceTextLayer") : t("sourceNone"),
              })),
            paper.snippet
              ? h("p", { className: "pt-meta pt-snippet", style: { margin: "6px 0 0", wordBreak: "break-word" } },
                snippetNodes(paper.snippet))
              : null,
          ),
        ),
        h("div", { style: { display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" } },
          h(Button, {
            variant: "primary",
            disabled: !hasPdf || busy === "open",
            title: hasPdf ? t("open") : t("noPdfForPaper"),
            onClick: () => onOpen({
              paperId: paper.paperId,
              title: paper.title,
              pageIndex: Number.isInteger(paper.pageIndex) ? paper.pageIndex : 0,
              quote: paper.snippet ? null : null,
              paper,
            }),
          }, t("open")),
          h(Button, { onClick: () => onEdit(paper), disabled: busy !== null }, t("editMeta")),
          // Only for a paper with no usable text. On a `fulltext` paper OCR would replace
          // correct text with guesses (the Host refuses it too); on an `ocr` paper there is
          // nothing new to recognise. Showing it everywhere would invite a click that can
          // only be refused, which reads as a bug.
          paper.material === "metadata" && hasPdf
            ? h(Button, {
              variant: "ghost",
              disabled: busy !== null,
              title: t("reocrHint"),
              onClick: async () => {
                const result = await onReocr(paper);
                if (result === null) return;
                setReocrResult(result);
              },
            }, busy === "reocr" ? t("working") : t("reocr"))
            : null,
          // Offered only when a DOI exists: without one there is nothing to look
          // up, and a button that must refuse is worse than no button. Independent
          // of `hasPdf` because a metadata-only entry (added from a search result)
          // can still have a DOI and benefit from enrichment.
          hasDoi
            ? h(Button, {
              variant: "ghost",
              disabled: busy !== null,
              title: t("enrichHint"),
              onClick: async () => {
                const result = await onEnrich(paper);
                if (result === null) return;
                setEnrichResult(result);
              },
            }, busy === "enrich" ? t("working") : t("enrich"))
            : null,
          // Only offered when there is a PDF to re-read. Showing it on a
          // metadata-only entry would promise an action that must fail.
          hasPdf
            ? h(Button, {
              variant: "ghost",
              disabled: busy !== null,
              title: t("reextractHint"),
              onClick: async () => {
                const result = await onReextract(paper);
                if (result === null) return;
                setReextractResult(result);
              },
            }, busy === "reextract" ? t("working") : t("reextract"))
            : null,
          confirming
            ? h(React.Fragment, null,
              h(Button, { variant: "danger", onClick: () => { setConfirming(false); onDelete(paper.paperId); }, disabled: busy !== null },
                t("confirm")),
              h(Button, { variant: "ghost", onClick: () => setConfirming(false) }, t("cancel")),
            )
            : h(Button, { variant: "ghost", onClick: () => setConfirming(true), disabled: busy !== null },
              t("delete")),
        ),
        reextractResult !== null
          ? h("p", { className: "pt-caption", role: "status", style: { margin: "6px 0 0" } },
            reextractResult.changed.length === 0 && reextractResult.disagreed.length === 0
              ? t("reextractNoChange")
              : [
                reextractResult.changed.length === 0
                  ? null
                  : t("reextractDone", {
                    count: reextractResult.changed.length,
                    fields: reextractResult.changed.map((field) => t(fieldLabelKey(field))).join(t("listSep")),
                  }),
                // Saying "nothing new" while the extractor disagrees with a kept
                // value would be a lie: the guard refused to overwrite what looks
                // like the user's own edit, but the user still deserves to know
                // what the PDF actually says.
                reextractResult.disagreed.length === 0
                  ? null
                  : t("reextractDisagreed", {
                    fields: reextractResult.disagreed.map((field) => t(fieldLabelKey(field))).join(t("listSep")),
                  }),
              ].filter((line) => line !== null).join(" — "))
          : null,
        enrichResult !== null
          ? h("p", { className: "pt-caption", role: "status", style: { margin: "6px 0 0" } },
            enrichResult.changed.length > 0
              ? t("enrichDone", {
                count: enrichResult.changed.length,
                fields: enrichResult.changed.map((field) => t(fieldLabelKey(field))).join(t("listSep")),
              })
              : enrichResult.reason === "no-doi"
                ? t("enrichNoDoi")
                : enrichResult.reason !== undefined
                  ? t("enrichFailed", { reason: enrichResult.reason })
                  : t("enrichNoChange"))
          : null,
        reocrResult !== null
          ? h("p", { className: "pt-caption", role: "status", style: { margin: "6px 0 0" } },
            reocrResult.skipped === true
              ? t("reocrSkipped", { reason: reocrResult.reason })
              : t("reocrDone", {
                pages: reocrResult.pagesRecognised ?? 0,
                failed: reocrResult.pagesFailed ?? 0,
                moved: reocrResult.reanchored?.evidence?.relocated ?? 0,
                lost: reocrResult.reanchored?.evidence?.lost ?? 0,
              }))
          : null,
      );
    }

    function MetadataEditor({ paper, t, onSave, onCancel, busy }) {
      const [form, setForm] = useState({
        title: paper.title ?? "",
        authors: paper.authors ?? "",
        year: paper.year ?? "",
        venue: paper.venue ?? "",
        doi: paper.doi ?? "",
        abstract: paper.abstract ?? "",
      });
      const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
      const field = (key, label, textarea) => h("label", { style: { display: "block" } },
        h("span", { className: "pt-caption", style: { display: "block", marginBottom: 3 } }, label),
        textarea
          ? h("textarea", { className: "pt-textarea", value: form[key], onChange: set(key) })
          : h("input", { className: "pt-input", value: form[key], onChange: set(key) }),
      );
      return h("div", { className: "pt-card", style: { display: "flex", flexDirection: "column", gap: 8 } },
        h("div", { className: "pt-h2" }, t("editMeta")),
        field("title", t("titleLabel")),
        field("authors", t("authorsLabel")),
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("div", { style: { flex: "0 0 96px" } }, field("year", t("yearLabel"))),
          h("div", { style: { flex: "1 1 160px", minWidth: 0 } }, field("venue", t("venueLabel"))),
        ),
        field("doi", t("doiLabel")),
        field("abstract", t("abstractLabel"), true),
        h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" } },
          h(Button, { variant: "ghost", onClick: onCancel }, t("cancel")),
          h(Button, { variant: "primary", onClick: () => onSave(form), disabled: busy !== null }, t("save")),
        ),
      );
    }

    // --- reader -----------------------------------------------------------

    function PdfReader({ sessionId, paper, initialPage, highlight, annotations, t, onSelectionChange, onClose }) {
      const canvasRef = useRef(null);
      const textLayerRef = useRef(null);
      const pageWrapRef = useRef(null);
      const docRef = useRef(null);
      const pdfjsRef = useRef(null);
      const tokenRef = useRef(0);
      const renderTaskRef = useRef(null);
      const [pageNumber, setPageNumber] = useState(Math.max(1, (initialPage ?? 0) + 1));
      const [numPages, setNumPages] = useState(0);
      const [scale, setScale] = useState(1.15);
      const [autoFit, setAutoFit] = useState(true);
      const [pageInput, setPageInput] = useState("");
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [textFallback, setTextFallback] = useState(null);
      const [selected, setSelected] = useState(null);
      const [highlightMissed, setHighlightMissed] = useState(false);
      // `annotations` arrives as a prop (the Body component owns the fetch, since the
      // list is also shown outside the reader). Only the per-page painted count lives
      // here.
      const [annotationsPainted, setAnnotationsPainted] = useState(0);
      // How many of this paper's annotations claim to sit on the page being shown.
      // Kept separate from the painted count so a shortfall is detectable.
      const annotationsOnPage = (annotations ?? []).filter((a) => a.pageIndex === pageNumber - 1).length;
      // The render callback is async and outlives prop updates; a ref keeps it reading
      // the latest list without re-rendering the page on every change.
      const annotationsRef = useRef(annotations ?? []);
      useEffect(() => {
        annotationsRef.current = annotations ?? [];
      }, [annotations]);
      // The loading task owns the worker; the document proxy does not. Keeping it
      // is what makes a clean teardown possible (see releasePdfDocument).
      const loadingTaskRef = useRef(null);

      useEffect(() => {
        setPageNumber(Math.max(1, (initialPage ?? 0) + 1));
      }, [initialPage, paper.paperId]);

      useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        (async () => {
          try {
            setLoading(true);
            setError(null);
            setTextFallback(null);
            const { pdfjs, workerUrl } = await loadPdfjs(sessionId);
            pdfjsRef.current = pdfjs;
            const payload = await callRemote(sessionId, "readPaperBytes", { paperId: paper.paperId }, controller.signal);
            if (cancelled) return;
            pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
            const assets = makeAssetFactory(pdfjs, sessionId);
            // Hold the loading task, not just the document. In PDF.js 6 the
            // document proxy has cleanup() but no destroy(); the worker thread is
            // owned by the loading task and is only released by loadingTask.
            // destroy(). Calling doc.destroy() — which this code did — throws
            // "doc.destroy is not a function", and because it ran inside the
            // effect's teardown it surfaced the moment the user pressed
            // 「返回列表」 to close the reader.
            const loadingTask = pdfjs.getDocument({
              data: new Uint8Array(payload.data),
              BinaryDataFactory: assets.BinaryDataFactory,
              cMapUrl: assets.cMapUrl,
              standardFontDataUrl: assets.standardFontDataUrl,
              cMapPacked: true,
              isEvalSupported: false,
              useWorkerFetch: false,
              enableXfa: false,
            });
            loadingTaskRef.current = loadingTask;
            const doc = await loadingTask.promise;
            if (cancelled) {
              // The effect was torn down while the document was still loading:
              // release it, or the worker and parsed fonts outlive the view.
              releasePdfDocument(loadingTask, doc);
              return;
            }
            docRef.current = doc;
            setNumPages(doc.numPages);
            setPageNumber((current) => Math.min(Math.max(1, current), doc.numPages));
          } catch (loadError) {
            if (!cancelled) setError(describeError(loadError, t));
          } finally {
            if (!cancelled) setLoading(false);
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
          // Never leave a PDF attached to a dead view: it owns a worker thread
          // and the parsed font/CMap caches.
          const task = loadingTaskRef.current;
          loadingTaskRef.current = null;
          const doc = docRef.current;
          docRef.current = null;
          releasePdfDocument(task, doc);
        };
      }, [sessionId, paper.paperId, t]);

      // Fit-to-width: the sidebar is narrow and dragged often, so the default
      // scale is derived from the available width instead of a fixed 1.15.
      useEffect(() => {
        if (!autoFit) return undefined;
        const wrap = canvasRef.current?.parentElement?.parentElement;
        if (!wrap) return undefined;
        const apply = () => {
          const doc = docRef.current;
          const width = wrap.clientWidth - 18;
          if (!doc || !Number.isFinite(width) || width <= 0) return;
          doc.getPage(Math.min(pageNumber, doc.numPages || 1))
            .then((page) => {
              const base = page.getViewport({ scale: 1 });
              const next = Math.max(0.3, Math.min(3, width / base.width));
              setScale(+next.toFixed(2));
            })
            .catch(() => {});
        };
        apply();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(() => apply());
        observer.observe(wrap);
        return () => observer.disconnect();
      }, [autoFit, pageNumber, numPages]);

      useEffect(() => {
        const doc = docRef.current;
        const pdfjs = pdfjsRef.current;
        if (!doc || !pdfjs || numPages === 0) return undefined;
        const token = tokenRef.current + 1;
        tokenRef.current = token;
        let cancelled = false;
        (async () => {
          try {
            const page = await doc.getPage(Math.min(pageNumber, numPages));
            if (cancelled || token !== tokenRef.current) return;
            const viewport = page.getViewport({ scale });
            const canvas = canvasRef.current;
            const textLayerDiv = textLayerRef.current;
            const pageWrap = pageWrapRef.current;
            if (!canvas || !textLayerDiv || !pageWrap) return;
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.floor(viewport.width * ratio);
            canvas.height = Math.floor(viewport.height * ratio);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            pageWrap.style.width = `${Math.floor(viewport.width)}px`;
            pageWrap.style.height = `${Math.floor(viewport.height)}px`;
            textLayerDiv.replaceChildren();
            textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
            textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
            textLayerDiv.style.setProperty("--total-scale-factor", String(scale));
            textLayerDiv.style.setProperty("--scale-factor", String(scale));
            const context = canvas.getContext("2d");
            // A canvas can refuse a context — the GPU process died, too many
            // contexts are open in this document, or the element was already
            // detached. Passing null to page.render() throws inside PDF.js and,
            // with no error boundary above this view, that blanked the whole pane.
            // Fall back to the text layer instead, which still lets the user read
            // and quote the page.
            if (!context) {
              const read = await callRemote(sessionId, "readPaper", {
                paperId: paper.paperId,
                fromPage: pageNumber - 1,
                toPage: pageNumber,
              }).catch(() => null);
              const text = read?.pages?.[0]?.text ?? "";
              if (!cancelled && token === tokenRef.current) {
                setTextFallback(text === "" ? t("textFallbackNote") : text);
                setError(null);
              }
              return;
            }
            // pdfjs refuses a second render on a canvas whose previous render is
            // still in flight ("Cannot use the same canvas during multiple
            // render tasks"), and rapid zoom/page clicks do exactly that.
            if (renderTaskRef.current !== null) {
              try { renderTaskRef.current.cancel(); } catch { /* already done */ }
              renderTaskRef.current = null;
            }
            const task = page.render({
              canvasContext: context,
              viewport,
              transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
            });
            renderTaskRef.current = task;
            await task.promise;
            renderTaskRef.current = null;
            if (cancelled || token !== tokenRef.current) return;
            try {
              const textLayer = new pdfjs.TextLayer({
                textContentSource: page.streamTextContent(),
                container: textLayerDiv,
                viewport,
              });
              // setLayerDimensions uses CSS round(), which older Chromium builds
              // may not support; pin the pixel size again after construction.
              textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
              textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
              await textLayer.render();
              if (!cancelled && token === tokenRef.current) {
                setTextFallback(null);
                // Persisted annotations paint first, then the evidence jump-target.
                // Order matters: the jump target uses a DOM selection, and painting
                // marks afterwards would leave the selection pointing at nodes that
                // no longer exist where the browser thinks they are.
                const pageAnnotations = (annotationsRef.current ?? []).filter(
                  (annotation) => annotation.pageIndex === pageNumber - 1,
                );
                const painted = paintHighlights(textLayerDiv, pageAnnotations);
                setAnnotationsPainted(painted);
                const wanted = highlight && highlight.pageIndex === pageNumber - 1 ? highlight.quote : "";
                const found = wanted !== "" && highlightInLayer(textLayerDiv, wanted);
                setHighlightMissed(wanted !== "" && !found);
                if (found) {
                  const next = { text: normalizeSelection(wanted), pageIndex: pageNumber - 1 };
                  setSelected(next);
                  onSelectionChange(next);
                }
              }
            } catch (layerError) {
              if (!cancelled && token === tokenRef.current) {
                const read = await callRemote(sessionId, "readPaper", {
                  paperId: paper.paperId,
                  fromPage: pageNumber - 1,
                  toPage: pageNumber,
                }).catch(() => null);
                const text = read?.pages?.[0]?.text ?? "";
                setTextFallback(text === "" ? `${t("textFallbackNote")} (${layerError?.message ?? layerError})` : text);
              }
            }
            if (!cancelled && token === tokenRef.current) setError(null);
          } catch (renderError) {
            // A cancelled render rejects with RenderingCancelledException; that
            // is the normal outcome of clicking faster than the page renders.
            const cancelledRender = renderError?.name === "RenderingCancelledException";
            if (!cancelled && token === tokenRef.current && !cancelledRender) {
              setError(describeError(renderError, t));
            }
          }
        })();
        return () => {
          cancelled = true;
          if (renderTaskRef.current !== null) {
            try { renderTaskRef.current.cancel(); } catch { /* already done */ }
            renderTaskRef.current = null;
          }
        };
      }, [pageNumber, scale, numPages, sessionId, paper.paperId, highlight, onSelectionChange, t]);

      const onMouseUp = useCallback(() => {
        const layer = textLayerRef.current;
        const selection = window.getSelection();
        if (!layer || !selection || selection.isCollapsed) return;
        const anchor = selection.anchorNode;
        if (anchor && !layer.contains(anchor)) return;
        const text = normalizeSelection(selection.toString());
        if (text === "") return;
        const next = { text: text.slice(0, MAX_QUOTE_CHARS), pageIndex: pageNumber - 1 };
        setSelected(next);
        onSelectionChange(next);
      }, [pageNumber, onSelectionChange]);

      const goToPage = useCallback(() => {
        const value = Number.parseInt(pageInput, 10);
        if (!Number.isFinite(value)) return;
        setPageNumber(Math.min(Math.max(1, value), numPages || 1));
        setPageInput("");
        setSelected(null);
        onSelectionChange(null);
      }, [pageInput, numPages, onSelectionChange]);

      const step = useCallback((delta) => {
        setAutoFit(false);
        setScale((current) => Math.max(0.3, Math.min(3, +(current + delta).toFixed(2))));
      }, []);

      return h("div", { className: "pt-reader" },
        h("div", { className: "pt-reader-bar" },
          h(Button, { variant: "ghost", onClick: onClose, icon: true, label: t("closeReader") }, "←"),
          h("span", { className: "pt-meta pt-num", style: { marginLeft: 2 } },
            `${pageNumber} ${t("of")} ${numPages || "?"}`),
          h("div", { className: "pt-spacer" }),
          h(Button, {
            icon: true, label: t("prevPage"), disabled: pageNumber <= 1,
            onClick: () => { setPageNumber((n) => Math.max(1, n - 1)); setSelected(null); onSelectionChange(null); },
          }, "‹"),
          h(Button, {
            icon: true, label: t("nextPage"), disabled: pageNumber >= numPages,
            onClick: () => { setPageNumber((n) => Math.min(numPages, n + 1)); setSelected(null); onSelectionChange(null); },
          }, "›"),
          h("input", {
            className: "pt-input", style: { width: 52, minHeight: 26, padding: "2px 6px" },
            value: pageInput, placeholder: t("jumpPlaceholder"), "aria-label": t("jumpPlaceholder"),
            onChange: (event) => setPageInput(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") goToPage(); },
          }),
          h(Button, {
            className: "pt-btn", icon: true, label: t("jump"),
            onClick: goToPage, disabled: pageInput.trim() === "",
          }, "↵"),
          h(Button, { icon: true, label: t("zoomOut"), disabled: scale <= 0.3, onClick: () => step(-0.15) }, "−"),
          h(Button, {
            icon: true, label: t("fitWidth"), title: t("fitWidth"),
            onClick: () => setAutoFit((current) => !current),
            variant: autoFit ? "primary" : undefined,
          }, "⤢"),
          h(Button, { icon: true, label: t("zoomIn"), disabled: scale >= 3, onClick: () => step(0.15) }, "+"),
        ),
        h("div", { className: "pt-caption", style: { wordBreak: "break-word" } },
          paper.title || paper.paperId),
        highlightMissed ? h("p", { className: "pt-meta", style: { margin: 0 } }, t("highlightMissed")) : null,
        // Annotations exist for this page but the text was not found where the stored
        // quote says it should be. That is a drifted anchor, not an empty page, and
        // silently showing nothing would make the user think their highlight was lost.
        annotationsOnPage > annotationsPainted
          ? h("p", { className: "pt-meta", style: { margin: 0 } },
            `${t("annotationAnchorMissed")} (${annotationsPainted}/${annotationsOnPage})`)
          : null,
        loading ? h("p", { className: "pt-meta", style: { margin: 0 } }, t("readerLoading")) : null,
        error ? h(Banner, { tone: "error" }, error) : null,
        h("div", { className: "pt-canvas-wrap" },
          h("div", { ref: pageWrapRef, className: "pt-page" },
            h("canvas", { ref: canvasRef, style: { display: "block" } }),
            h("div", { ref: textLayerRef, className: "pt-textLayer", onMouseUp }),
          ),
        ),
        textFallback !== null
          ? h("div", null,
            h("p", { className: "pt-caption", style: { margin: "0 0 4px" } }, t("textFallbackNote")),
            h("pre", {
              className: "pt-pre",
              style: { maxHeight: "26vh" },
              onMouseUp: () => {
                const text = normalizeSelection(window.getSelection()?.toString() ?? "");
                if (text === "") return;
                const next = { text: text.slice(0, MAX_QUOTE_CHARS), pageIndex: pageNumber - 1 };
                setSelected(next);
                onSelectionChange(next);
              },
            }, textFallback),
          )
          : null,
        selected
          ? h("p", { className: "pt-caption", style: { margin: 0 } },
            `${t("selected")} · ${selected.text.length} / ${MAX_QUOTE_CHARS}`)
          : h("p", { className: "pt-caption", style: { margin: 0 } }, t("noSelection")),
      );
    }

    // --- evidence ---------------------------------------------------------

    const STANCE_TONE = {
      support: "support",
      conflict: "conflict",
      not_found: undefined,
      no_evidence: "quiet",
      covered: "info",
      empty: "quiet",
    };

    function StanceBadge({ stance, t }) {
      const label = stance === "support"
        ? t("support")
        : stance === "conflict"
          ? t("conflict")
          : stance === "no_evidence"
            ? t("noEvidenceStance")
            : stance === "covered"
              ? t("covered")
              : stance === "empty"
                ? t("emptyCoverage")
                : t("notFound");
      return h(Badge, { tone: STANCE_TONE[stance] }, label);
    }

    function EvidenceRow({ row, t, onJump, onDelete, busy }) {
      const anchored = Number.isInteger(row.charStart) && row.charStart >= 0;
      // A quote from OCR text may contain misread characters. Saying so here is
      // the difference between "I can cite this" and "I should re-read the page".
      const fromOcr = row.paperTextSource === "ocr";
      return h("div", { style: { display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 0" } },
        h("div", { className: "pt-row-main" },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 3, flexWrap: "wrap" } },
            h(Badge, { tone: anchored ? "info" : "warn" }, anchored ? t("evidenceAnchored") : t("evidenceUnanchored")),
            fromOcr ? h(Badge, { tone: "warn", title: t("ocrHint") }, t("ocrText")) : null,
            h("span", { className: "pt-caption pt-num" }, `${t("page")} ${row.pageIndex + 1}`),
          ),
          h("p", { className: "pt-body", style: { margin: 0, wordBreak: "break-word" } }, row.quote),
          anchored ? null : h("p", { className: "pt-caption", style: { margin: "3px 0 0" } }, t("evidenceUnanchoredHint")),
          fromOcr ? h("p", { className: "pt-caption", style: { margin: "3px 0 0" } }, t("ocrQuoteHint")) : null,
        ),
        h("div", { className: "pt-row-aside" },
          h(Button, { icon: true, label: t("jumpToPage"), onClick: () => onJump(row), disabled: busy !== null }, "↗"),
          h(Button, { icon: true, variant: "ghost", label: t("delete"), onClick: () => onDelete(row.evidenceId), disabled: busy !== null }, "✕"),
        ),
      );
    }

    // --- body -------------------------------------------------------------

    function Body({ sessionId, inputActions, t }) {
      ensureCss();
      const [view, setView] = useState("library");
      const [mode, setMode] = useState("library");
      const [query, setQuery] = useState("");
      const [papers, setPapers] = useState([]);
      const [hits, setHits] = useState(null);
      const [candidates, setCandidates] = useState(null);
      const [picked, setPicked] = useState({});
      const [status, setStatus] = useState(null);
      const [failures, setFailures] = useState([]);
      const [cnki, setCnki] = useState(null);
      const [reader, setReader] = useState(null);
      const [editing, setEditing] = useState(null);
      const [selection, setSelection] = useState(null);
      const [question, setQuestion] = useState("");
      // Held separately from `note` (which belongs to the evidence editor): the two
      // are different annotations on different things and sharing one field would
      // leak a note typed for a highlight into the evidence form.
      const [annotationNote, setAnnotationNote] = useState("");
      const [annotationMessage, setAnnotationMessage] = useState("");
      // Annotation rows for the open paper. Fetched here rather than in PdfReader so
      // the list stays visible (and refreshable) even when no reader is open.
      const [annotations, setAnnotations] = useState([]);
      const [busy, setBusy] = useState(null);
      // Cancellation. `abortRef` holds the controller for whichever long job is
      // running; `busyStage` is what the user reads while it runs (a disabled button
      // with no label is indistinguishable from a frozen UI). Only one job can be
      // cancelled at a time because only one runs at a time.
      const abortRef = useRef(null);
      const [busyStage, setBusyStage] = useState("");
      const [cancelMessage, setCancelMessage] = useState("");
      // The packet returned by askContext for the most recent question, kept so the
      // answer can be written back to the same page/character anchor without asking
      // the Host to locate it again.
      const [lastAsk, setLastAsk] = useState(null);
      const [answerText, setAnswerText] = useState("");
      const [note, setNote] = useState("");
      const [error, setError] = useState(null);
      const [evidence, setEvidence] = useState([]);
      const [evidenceFilter, setEvidenceFilter] = useState("all");
      const [collectQuery, setCollectQuery] = useState("");
      const [matrixClaim, setMatrixClaim] = useState("");
      const [matrix, setMatrix] = useState(null);
      const [outline, setOutline] = useState(null);
      const [citationStyle, setCitationStyle] = useState("apa");
      const [citationLocale, setCitationLocale] = useState("zh-CN");
      const [citation, setCitation] = useState(null);
      const [exported, setExported] = useState(null);
      const fileInputRef = useRef(null);

      const openReader = useCallback((target) => {
        setReader(target);
        setSelection(null);
        setView("library");
      }, []);

      /**
       * Start a long job the user can stop.
       *
       * The controller is created here rather than inside each caller so that every
       * cancellable operation has exactly one cancellation entry point — the button
       * in the busy row — which is what makes "cancel" a property of the UI rather
       * than a per-call-site afterthought.
       */
      const runCancellable = useCallback(async (stage, work) => {
        const controller = new AbortController();
        abortRef.current = controller;
        setBusyStage(stage);
        setCancelMessage("");
        try {
          return await work(controller.signal);
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
          setBusyStage("");
        }
      }, []);

      const cancelBusy = useCallback(() => {
        const controller = abortRef.current;
        if (controller === null) return;
        // `abort()` makes the far end throw a DOMException named AbortError, which the
        // host reports as a cancellation rather than as a failed import.
        controller.abort(new DOMException("cancelled by the user", "AbortError"));
        abortRef.current = null;
        setCancelMessage(t("cancelledByUser"));
      }, [t]);

      const loadEvidence = useCallback(async () => {
        if (!sessionId) return [];
        const result = await callRemote(sessionId, "listEvidence", { limit: 2000 });
        const rows = result.evidence ?? [];
        setEvidence(rows);
        return rows;
      }, [sessionId]);

      /**
       * Load this paper's annotations from the host.
       *
       * Separate from evidence on purpose: they are different tables with different
       * meanings (a highlight is "I marked this", evidence is "this supports a
       * claim"), and merging the two fetches would invite the same confusion the
       * storage layer is careful to avoid.
       *
       * `reader` is the currently open paper; with none open there is nothing to
       * annotate, so the fetch is skipped rather than querying the whole library.
       */
      const loadAnnotations = useCallback(async () => {
        if (!sessionId || !reader?.paperId) return [];
        const result = await callRemote(sessionId, "listAnnotations", { paperId: reader.paperId, limit: 1000 }).catch(() => null);
        const rows = result?.annotations ?? [];
        setAnnotations(rows);
        return rows;
      }, [sessionId, reader?.paperId]);

      /** Save the current selection as an annotation, or update one by id. */
      const saveAnnotation = useCallback(
        async ({ quote, note, tags, color, annotationId, pageIndex, charStart, charEnd }) => {
          if (!sessionId || !reader?.paperId) return null;
          const result = await callRemote(sessionId, "saveAnnotation", {
            paperId: reader.paperId,
            annotationId,
            pageIndex: pageIndex ?? (selection?.pageIndex ?? 0),
            charStart: charStart ?? -1,
            charEnd: charEnd ?? -1,
            quote: quote ?? "",
            note: note ?? "",
            tags: tags ?? [],
            color: color ?? "yellow",
          }).catch((saveError) => ({ ok: false, reason: saveError?.message ?? String(saveError) }));
          if (result?.ok) await loadAnnotations();
          return result;
        },
        [sessionId, reader?.paperId, selection, loadAnnotations],
      );

      const removeAnnotation = useCallback(
        async (annotationId) => {
          if (!sessionId) return null;
          const result = await callRemote(sessionId, "deleteAnnotation", { annotationId }).catch(() => null);
          if (result?.ok) await loadAnnotations();
          return result;
        },
        [sessionId, loadAnnotations],
      );

      const refresh = useCallback(async () => {
        if (!sessionId) return;
        try {
          const [state, listed] = await Promise.all([
            callRemote(sessionId, "status"),
            callRemote(sessionId, "listPapers", { limit: 500 }),
          ]);
          setStatus(state);
          setPapers(listed.papers ?? []);
          setError(null);
          await loadEvidence();
          // Annotations load alongside evidence but from their own endpoint: they are
          // a different table with a different meaning, and a failure here must not
          // take down the evidence list.
          await loadAnnotations();
        } catch (statusError) {
          setError(describeError(statusError, t));
        }
      }, [sessionId, loadEvidence, loadAnnotations, t]);

      useEffect(() => { refresh(); }, [refresh]);

      useEffect(() => {
        if ((mode !== "external" && mode !== "cnki") || !sessionId) return undefined;
        let cancelled = false;
        (async () => {
          try {
            const state = await callRemote(sessionId, "cnkiStatus");
            if (!cancelled) setCnki(state);
          } catch {
            /* a missing CNKI module must not break the panel */
          }
        })();
        return () => { cancelled = true; };
      }, [mode, sessionId]);

      const doSearch = useCallback(async () => {
        if (!sessionId || query.trim() === "") { setHits(null); return; }
        setBusy("search");
        setNote("");
        setError(null);
        try {
          if (mode === "external") {
            // External search hits the network across several sources, so it is the
            // search most likely to hang long enough for the user to give up.
            const result = await runCancellable(t("busyStageSearch"), (signal) =>
              callRemote(sessionId, "searchExternal", { query, limit: 10 }, signal),
            );
            setCandidates(result.candidates ?? []);
            setFailures(result.failures ?? []);
            setHits(null);
            setPicked({});
          } else if (mode === "cnki") {
            const result = await runCancellable(t("busyStageSearch"), (signal) =>
              callRemote(sessionId, "cnkiSearch", { query, limit: 20 }, signal),
            );
            if (result.ok !== true) {
              setCandidates([]);
              setFailures([{ source: "cnki", reason: result.reason ?? "unavailable" }]);
            } else {
              setCandidates((result.results ?? []).map((row) => ({
                title: row.title,
                authors: row.authors,
                year: (/(\d{4})/.exec(row.date ?? "") ?? [])[1] ?? "",
                venue: row.venue,
                doi: "",
                source: "cnki",
                href: row.href,
              })));
              setFailures([]);
            }
            setHits(null);
            setPicked({});
          } else {
            const result = await callRemote(sessionId, "search", { query, limit: 50 });
            setHits(result.hits ?? []);
            setStatus((current) => (current === null ? current : { ...current, library: result.library }));
            setCandidates(null);
            setFailures([]);
          }
        } catch (searchError) {
          // A cancelled search must not leave the panel in a loading state: the
          // candidates array is cleared so the "no results" path renders instead of a
          // spinner, and the reason is stated in neutral text rather than as an error.
          if (isAbortError(searchError)) {
            setCandidates(null);
            setHits(null);
            setFailures([]);
          } else {
            setError(describeError(searchError, t));
          }
        } finally {
          setBusy(null);
        }
      }, [sessionId, query, mode, t, runCancellable]);

      const addPicked = useCallback(async () => {
        if (!sessionId || !candidates) return;
        const chosen = candidates.filter((_candidate, index) => picked[index]);
        if (chosen.length === 0) return;
        setBusy("add");
        setNote("");
        setError(null);
        try {
          if (mode === "cnki") {
            let added = 0;
            const problems = [];
            for (let index = 0; index < chosen.length; index += 1) {
              const candidate = chosen[index];
              setNote(`${t("downloading")} ${index + 1}/${chosen.length}`);
              if (!candidate.href) {
                problems.push(`${candidate.title}: ${t("noCandidates")}`);
                continue;
              }
              try {
                const result = await callRemote(sessionId, "cnkiDownload", {
                  href: candidate.href,
                  title: candidate.title,
                  authors: candidate.authors,
                  year: candidate.year,
                  venue: candidate.venue,
                });
                if (result.ok === true && (result.imported?.length ?? 0) > 0) added += 1;
                else problems.push(`${candidate.title}: ${result.reason ?? "download failed"}`);
              } catch (downloadError) {
                problems.push(`${candidate.title}: ${describeError(downloadError, t)}`);
              }
            }
            setNote(`${t("added")} ${added}${problems.length > 0 ? ` · ${problems.length} ✕` : ""}`);
            if (problems.length > 0) setError(problems.slice(0, 3).join("; "));
            setPicked({});
          } else {
            const result = await callRemote(sessionId, "addCandidates", { candidates: chosen });
            const skipped = result.duplicates?.length ?? 0;
            setNote(`${t("added")} ${result.imported?.length ?? 0}${skipped > 0 ? ` · ${skipped} ${t("skipped")}` : ""}`);
            setPicked({});
            setCandidates(candidates.filter((_candidate, index) => !picked[index]));
          }
          await refresh();
        } catch (addError) {
          setError(describeError(addError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, candidates, picked, mode, t, refresh]);

      const doImport = useCallback(async (fileList) => {
        if (!sessionId || !fileList || fileList.length === 0) return;
        setBusy("import");
        setNote("");
        setError(null);
        try {
          if (fileList.length > MAX_IMPORT_FILES) {
            setError(t("tooManyFiles", { limit: MAX_IMPORT_FILES }));
            return;
          }
          const files = [];
          for (let index = 0; index < fileList.length; index += 1) {
            const file = fileList[index];
            // Check the size before reading: turning a 300MB file into a number
            // array blocks the tab long before the Host can reject it.
            if (file.size > MAX_PDF_BYTES) {
              setError(t("tooLarge", { limit: Math.round(MAX_PDF_BYTES / 1024 / 1024) }));
              return;
            }
            setNote(`${t("importing")} ${index + 1}/${fileList.length}`);
            const buffer = await file.arrayBuffer();
            // The wire is JSON: send a number array, not a Uint8Array (which
            // would serialize as an object and fail the Host's byte parser).
            files.push({ name: file.name, data: Array.from(new Uint8Array(buffer)) });
          }
          const result = await runCancellable(t("busyStageImport"), (signal) =>
            callRemote(sessionId, "importPdf", { files }, signal),
          );
          const okCount = result.imported?.length ?? 0;
          const dupCount = result.duplicates?.length ?? 0;
          const failCount = result.failed?.length ?? 0;
          await refresh();
          setNote([
            okCount > 0 ? `✓ ${okCount}` : "",
            dupCount > 0 ? `= ${dupCount}` : "",
            failCount > 0 ? `✕ ${failCount}` : "",
            // A cancelled import keeps what finished and says how much was dropped;
            // reporting only the successes would make a half-done import look done.
            result.aborted === true ? t("cancelSkipped", { n: result.skipped ?? 0 }) : "",
          ].filter(Boolean).join(" · "));
          setHits(null);
          setError(failCount > 0 ? result.failed.map((item) => `${item.filename}: ${item.reason}`).join("; ") : null);
        } catch (importError) {
          // A cancellation is not an error: describeError would print "AbortError" in
          // red, which reads as a crash. The cancel banner already said what happened,
          // so refresh and let that stand.
          if (isAbortError(importError)) {
            await refresh();
          } else {
            setError(describeError(importError, t));
          }
        } finally {
          setBusy(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }
      }, [sessionId, t, refresh, runCancellable]);

      const saveMetadata = useCallback(async (form) => {
        if (!sessionId || !editing) return;
        setBusy("metadata");
        try {
          await callRemote(sessionId, "updatePaper", { paperId: editing.paperId, ...form });
          setEditing(null);
          await refresh();
          setNote(t("save"));
        } catch (saveError) {
          setError(describeError(saveError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, editing, t, refresh]);

      const deletePaper = useCallback(async (paperId) => {
        if (!sessionId) return;
        setBusy("delete");
        try {
          await callRemote(sessionId, "deletePaper", { paperId });
          if (reader?.paperId === paperId) setReader(null);
          setHits((current) => (current ? current.filter((hit) => hit.paperId !== paperId) : current));
          await refresh();
        } catch (deleteError) {
          setError(describeError(deleteError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, reader, refresh, t]);

      /**
       * Re-run bibliographic extraction on one paper's stored PDF.
       *
       * Needed because extraction only happens at import: a paper imported before
       * the extractor improved keeps its old (often empty) authors and journal
       * forever, and there is no other way to repair it short of deleting the
       * entry and importing the file again.
       *
       * The outcome is returned to the caller rather than swallowed: the user asked
       * to fix something and needs to know whether it worked and what moved.
       */
      const reextractOne = useCallback(async (paper) => {
        if (!sessionId) return null;
        setBusy("reextract");
        setError("");
        try {
          const result = await callRemote(sessionId, "reextractMetadata", { paperId: paper.paperId });
          await refresh();
          return {
            changed: Object.keys(result?.changed ?? {}),
            // The host reports fields it found a better value for but kept, and
            // dropping that here would present the stored value as confirmed.
            disagreed: Object.keys(result?.disagreed ?? {}),
          };
        } catch (reextractError) {
          setError(describeError(reextractError, t));
          return null;
        } finally {
          setBusy(null);
        }
      }, [sessionId, refresh, t]);

      /**
       * Re-run OCR for one paper.
       *
       * Wrapped in runCancellable because recognition is roughly a second per page: a
       * 200-page scan is minutes of waiting, and a run the user cannot stop is the same
       * as a hang. The Host honours the same signal, so a cancelled run leaves the paper
       * exactly as it was rather than half-recognised.
       */
      const reocrOne = useCallback(async (paper) => {
        if (!sessionId) return null;
        setBusy("reocr");
        setError("");
        try {
          return await runCancellable(t("busyStageOcr"), async (signal) => {
            const result = await callRemote(sessionId, "ocrPaper", { paperId: paper.paperId }, signal);
            await refresh();
            return result;
          });
        } catch (reocrError) {
          // A cancellation is not a failure: say it was stopped, don't report an error.
          if (isAbortError(reocrError)) {
            setCancelMessage(t("cancelledByUser"));
            return null;
          }
          setError(describeError(reocrError, t));
          return null;
        } finally {
          setBusy(null);
        }
      }, [sessionId, refresh, runCancellable, t]);

      /**
       * Fill this paper's metadata from Crossref via its DOI.
       *
       * Needed because the extractor cannot read authors off a typeset page, so
       * many imported papers have a title and year but no authors or venue — and a
       * bibliography built from those is wrong in a way that looks legitimate. The
       * DOI is an exact identifier, so this is a lookup rather than a guess.
       *
       * The outcome is returned rather than swallowed: the user asked to fix
       * something and needs to know whether it worked, and if not, why.
       */
      const enrichOne = useCallback(async (paper) => {
        if (!sessionId) return null;
        if (typeof paper?.doi !== "string" || paper.doi.trim() === "") {
          return { changed: [], reason: "no-doi" };
        }
        setBusy("enrich");
        setError("");
        try {
          const result = await callRemote(sessionId, "enrichMetadata", { paperId: paper.paperId });
          await refresh();
          const entry = (result?.enriched ?? []).find((row) => row.paperId === paper.paperId);
          const changed = Array.isArray(entry?.changed) ? entry.changed : [];
          const failure = (result?.failures ?? []).find((row) => row.paperId === paper.paperId);
          if (failure !== undefined) return { changed: [], reason: failure.reason };
          if (changed.length === 0) {
            const skipped = (result?.skipped ?? []).find((row) => row.paperId === paper.paperId);
            return { changed: [], reason: skipped?.reason };
          }
          return { changed };
        } catch (enrichError) {
          setError(describeError(enrichError, t));
          return null;
        } finally {
          setBusy(null);
        }
      }, [sessionId, refresh, t]);

      const insertToChat = useCallback((text) => {
        const actions = inputActions;
        if (!actions) {
          setError("inputActions unavailable in this seat");
          return false;
        }
        try {
          const span = actions.captureInsertion();
          if (!span || typeof span.draftRev !== "number") {
            throw new Error("captureInsertion returned no draft revision");
          }
          const accepted = actions.insertText(text, span);
          if (accepted === false) throw new Error("the composer rejected the insertion");
          setNote(t("sentToChat"));
          return true;
        } catch (insertError) {
          setError(describeError(insertError, t));
          return false;
        }
      }, [inputActions, t]);

      /**
       * Ask about the selected passage.
       *
       * The packet is built by the Host (`askContext`), not here. Two reasons, both
       * about traceability:
       *
       *  - The page and character anchor must be computed from the stored page text.
       *    Building a "page 3" header in the browser takes the page from whatever the
       *    sidebar is displaying, which is not necessarily the page the passage lives
       *    on — and once the text is in the composer, nothing can tell them apart.
       *  - A string built here cannot be validated. A packet with `anchored: false`
       *    is a packet whose passage was never found on the page, and the model needs
       *    to know that before it cites a location.
       *
       * The plugin still does not call a model (D-014): the packet goes through the
       * same "insert into composer" path, and the Agent answers in the conversation.
       */
      const askSelection = useCallback(async () => {
        if (!selection || !reader || !sessionId) return;
        const text = question.trim() === "" ? t("askDefault") : question.trim();
        setBusy("ask");
        setError(null);
        try {
          const packet = await callRemote(sessionId, "askContext", {
            paperId: reader.paperId,
            question: text,
            selectionText: selection.text,
            pageIndex: selection.pageIndex,
          });
          // The prompt line names the anchor only when the passage was actually found,
          // so a failed anchor search cannot be read as a successful one.
          const where = packet.selection.anchored
            ? `${t("askPage")} ${packet.selection.pageIndex + 1} · ${t("askChars")} ${packet.selection.charStart}-${packet.selection.charEnd}`
            : `${t("askPage")} ${packet.selection.pageIndex + 1} · ${t("askAnchorMissing")}`;
          const composed = [
            `[paper] ${packet.title} (${packet.paperId})`,
            `[${t("askAnchor")}] ${where}`,
            `[${t("askSelection")}] ${packet.selection.text}`,
            `[${t("askQuestion")}] ${packet.question}`,
            packet.selection.anchored
              ? ""
              : `[!] ${t("askAnchorMissingHint")}`,
          ].filter((line) => line !== "").join("\n");
          if (insertToChat(composed)) {
            setQuestion("");
            // Remember the packet so the answer can be written back to the same anchor
            // without asking the Host to re-locate it.
            setLastAsk(packet);
          }
        } catch (askError) {
          setError(describeError(askError, t));
        } finally {
          setBusy(null);
        }
      }, [selection, reader, question, insertToChat, sessionId, t]);

      /**
       * Write the answer back to the anchor it came from.
       *
       * A deliberate second action rather than part of asking: the answer does not
       * exist yet when the question is inserted, and not every answer is worth
       * keeping. The user decides.
       */
      const saveAnswer = useCallback(async (kind) => {
        if (!lastAsk) return;
        const answer = answerText.trim();
        if (answer === "") {
          setError(t("answerEmpty"));
          return;
        }
        if (!sessionId) return;
        setBusy("answer");
        setError(null);
        try {
          const saved = await callRemote(sessionId, "saveAnswer", {
            paperId: lastAsk.paperId,
            pageIndex: lastAsk.selection.pageIndex,
            charStart: lastAsk.selection.charStart,
            charEnd: lastAsk.selection.charEnd,
            question: lastAsk.question,
            answer,
            // Evidence needs the paper's own words; the note path does not.
            sourceQuote: lastAsk.selection.text,
            kind,
          });
          setNote(kind === "note" ? t("answerSavedNote") : t("answerSavedEvidence"));
          setAnswerText("");
          setLastAsk(null);
          await refresh();
          void saved;
        } catch (saveError) {
          setError(describeError(saveError, t));
        } finally {
          setBusy(null);
        }
      }, [lastAsk, answerText, sessionId, t, refresh]);

      const saveEvidence = useCallback(async () => {
        if (!selection || !reader || !sessionId) return;
        if (selection.text.length > MAX_QUOTE_CHARS) {
          setError(t("quoteTooLong", { limit: MAX_QUOTE_CHARS }));
          return;
        }
        setBusy("evidence");
        setError(null);
        try {
          const result = await callRemote(sessionId, "addEvidence", {
            paperId: reader.paperId,
            pageIndex: selection.pageIndex,
            quote: selection.text,
          });
          setNote(`${t("evidenceSaved")}${result.anchored ? "" : ` · ${t("evidenceUnanchored")}`}`);
          await refresh();
        } catch (evidenceError) {
          setError(describeError(evidenceError, t));
        } finally {
          setBusy(null);
        }
      }, [selection, reader, sessionId, t, refresh]);

      const collectEvidence = useCallback(async () => {
        if (!sessionId || collectQuery.trim() === "") return;
        setBusy("collect");
        setError(null);
        try {
          const result = await callRemote(sessionId, "collectEvidence", { query: collectQuery.trim(), limit: 20 });
          setNote(`${t("added")} ${result.evidence?.length ?? 0} ${t("evidenceCount")}`);
          await refresh();
        } catch (collectError) {
          setError(describeError(collectError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, collectQuery, t, refresh]);

      const removeEvidence = useCallback(async (evidenceId) => {
        if (!sessionId) return;
        try {
          await callRemote(sessionId, "deleteEvidence", { evidenceId });
          await refresh();
        } catch (removeError) {
          setError(describeError(removeError, t));
        }
      }, [sessionId, refresh, t]);

      const checkMatrix = useCallback(async (claim) => {
        if (!sessionId) return;
        setBusy("matrix");
        setError(null);
        try {
          const result = await callRemote(sessionId, "reviewMatrix", { claim });
          setMatrix(result);
        } catch (matrixError) {
          setError(describeError(matrixError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, t]);

      const buildOutline = useCallback(async () => {
        if (!sessionId) return;
        setBusy("outline");
        setError(null);
        try {
          const result = await callRemote(sessionId, "reviewOutline");
          setOutline(result);
        } catch (outlineError) {
          setError(describeError(outlineError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, t]);

      // Only evidence whose offsets were located in the page text may be
      // exported: a citation that cannot point at the source is exactly what
      // the traceability claim forbids.
      const locatedEvidence = useMemo(
        () => evidence.filter((row) => Number.isInteger(row.charStart) && row.charStart >= 0),
        [evidence],
      );
      const evidenceIds = useMemo(
        () => locatedEvidence.map((row) => row.evidenceId),
        [locatedEvidence],
      );
      const excludedCount = evidence.length - locatedEvidence.length;

      const readerHighlight = useMemo(
        () => (reader?.quote ? { quote: reader.quote, pageIndex: reader.pageIndex } : null),
        [reader?.quote, reader?.pageIndex],
      );

      const renderCitations = useCallback(async () => {
        if (!sessionId) return;
        setBusy("citations");
        setError(null);
        try {
          const result = await callRemote(sessionId, "formatCitations", {
            style: citationStyle, locale: citationLocale, evidenceIds,
          });
          setCitation(result);
        } catch (citationError) {
          setError(describeError(citationError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, citationStyle, citationLocale, evidenceIds, t]);

      const doExport = useCallback(async () => {
        if (!sessionId) return;
        setBusy("export");
        setError(null);
        try {
          const result = await callRemote(sessionId, "exportReview", {
            style: citationStyle,
            locale: citationLocale,
            evidenceIds,
          });
          setExported(result);
          if (result.ok !== true) setError(result.reason ?? "export failed");
          else {
            setNote(`${t("exported")} ${result.paths?.dir ?? ""}`);
            setCitation({
              ok: true, styleId: result.styleId, bibliography: result.bibliography,
              citation: result.citation, entries: result.entries,
            });
          }
        } catch (exportError) {
          setError(describeError(exportError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, citationStyle, citationLocale, evidenceIds, t]);

      const copyMarkdown = useCallback(async () => {
        const text = exported?.markdown ?? citation?.bibliography;
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          setNote(t("copied"));
        } catch {
          setError("clipboard unavailable");
        }
      }, [exported, citation, t]);

      const sendOutline = useCallback(() => {
        if (!outline?.text) return;
        insertToChat([
          "【研究材料】以下是从本地文献库收集的、带页码定位的证据。",
          outline.text,
          "【任务】请基于以上证据写综述；每句需要证据时标注 [E:证据id前8位]。不要引入材料之外的事实。",
        ].join("\n\n"));
      }, [outline, insertToChat]);

      // Search hits carry only display fields; merge in the stored row so the
      // card knows whether a PDF exists. Group multiple page hits of the same
      // paper into one card instead of printing the title once per page.
      const list = useMemo(() => {
        if (hits === null) return papers;
        const paperById = new Map(papers.map((paper) => [paper.paperId, paper]));
        const grouped = new Map();
        for (const hit of hits) {
          const merged = { ...(paperById.get(hit.paperId) ?? {}), ...hit };
          const existing = grouped.get(hit.paperId);
          if (existing === undefined) grouped.set(hit.paperId, { ...merged, hitCount: 1 });
          else existing.hitCount += 1;
        }
        return [...grouped.values()];
      }, [hits, papers]);

      const evidenceGroups = useMemo(() => {
        const grouped = new Map();
        for (const row of evidence) {
          if (evidenceFilter === "anchored" && !(Number.isInteger(row.charStart) && row.charStart >= 0)) continue;
          if (evidenceFilter === "unanchored" && Number.isInteger(row.charStart) && row.charStart >= 0) continue;
          if (!grouped.has(row.paperId)) grouped.set(row.paperId, []);
          grouped.get(row.paperId).push(row);
        }
        return [...grouped.entries()];
      }, [evidence, evidenceFilter]);

      const jumpToEvidence = useCallback((row) => {
        openReader({
          paperId: row.paperId,
          title: row.paperTitle,
          pageIndex: row.pageIndex,
          quote: row.quote,
          paper: { paperId: row.paperId, title: row.paperTitle },
        });
      }, [openReader]);

      const failureText = failures.map((failure) => `${failure.source} (${failure.reason})`).join(", ");
      const libraryCount = status?.library?.papers ?? papers.length;

      const counts = {
        library: libraryCount,
        evidence: evidence.length,
      };

      // --- views ----------------------------------------------------------

      const renderLibrary = () => h(React.Fragment, null,
        h("div", { style: { padding: "10px 12px 0", display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { className: "pt-toolbar" },
            h("input", {
              className: "pt-input pt-toolbar-grow",
              value: query,
              placeholder: t("searchPlaceholder"),
              "aria-label": t("searchPlaceholder"),
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") doSearch(); },
            }),
            h(Button, { variant: "primary", onClick: doSearch, disabled: busy !== null || query.trim() === "" },
              busy === "search" ? t("searching") : t("search")),
            hits !== null ? h(Button, { variant: "ghost", onClick: () => { setHits(null); setQuery(""); } }, t("clear")) : null,
          ),
          h("div", { className: "pt-toolbar" },
            h("span", { className: "pt-caption" }, t("searchScope")),
            h(Button, {
              variant: mode === "library" ? "primary" : "ghost",
              onClick: () => { setMode("library"); setCandidates(null); setFailures([]); setHits(null); },
            }, t("localLibrary")),
            h(Button, {
              variant: mode === "external" ? "primary" : "ghost",
              onClick: () => { setMode("external"); setHits(null); },
            }, t("external")),
            h(Button, {
              variant: mode === "cnki" ? "primary" : "ghost",
              onClick: () => { setMode("cnki"); setHits(null); },
            }, t("cnki")),
            h("div", { className: "pt-spacer" }),
            h(Button, { onClick: () => fileInputRef.current?.click(), disabled: busy !== null },
              busy === "import" ? t("importing") : t("import")),
            h("input", {
              ref: fileInputRef, type: "file", accept: "application/pdf", multiple: true,
              "aria-label": t("import"),
              style: { display: "none" },
              onChange: (event) => doImport(event.target.files),
            }),
          ),
          (mode === "external" || mode === "cnki") ? h("div", { className: "pt-toolbar" },
            h(Badge, { tone: cnki?.loggedIn ? "support" : undefined },
              `${t("cnki")} · ${cnki === null ? "—" : cnki.loggedIn ? t("cnkiConnected") : t("cnkiNotLoggedIn")}`),
            h("div", { className: "pt-spacer" }),
            h(Button, {
              disabled: busy !== null,
              onClick: async () => {
                setBusy("cnki");
                setNote(t("cnkiConnecting"));
                setError(null);
                try {
                  const state = await callRemote(sessionId, "cnkiConnect");
                  setCnki(state);
                  setNote(state.hint ?? "");
                  if (state.ok === false) setError(state.reason ?? "CNKI unavailable");
                } catch (connectError) {
                  setError(describeError(connectError, t));
                } finally {
                  setBusy(null);
                }
              },
            }, cnki?.loggedIn ? t("cnkiRecheck") : t("cnkiConnect")),
          ) : null,
          mode === "cnki" ? h("p", { className: "pt-caption", style: { margin: 0 } }, t("cnkiHint")) : null,
          failures.length > 0 ? h(Banner, { tone: "error", title: t("sourcesFailed") }, failureText) : null,
          editing ? h(MetadataEditor, { paper: editing, t, onSave: saveMetadata, onCancel: () => setEditing(null), busy }) : null,
        ),

        reader ? h("div", { style: { padding: "8px 12px 0", flex: "1 1 auto", minHeight: 0, display: "flex" } },
          h(PdfReader, {
            sessionId, paper: reader, initialPage: reader.pageIndex,
            highlight: readerHighlight,
            // Persisted annotations, so the reader can paint its own marks on every
            // page it renders rather than only showing evidence jump-targets.
            annotations,
            t,
            onSelectionChange: setSelection,
            onClose: () => { setReader(null); setSelection(null); },
          }),
        ) : null,

        selection && reader ? h("div", { style: { padding: "8px 12px 0" } },
          h("div", { className: "pt-well", style: { padding: 8, display: "flex", flexDirection: "column", gap: 6 } },
            h("div", { className: "pt-caption" },
              `${t("selected")} · ${t("page")} ${selection.pageIndex + 1} · ${selection.text.length}/${MAX_QUOTE_CHARS}`),
            h("p", { className: "pt-body", style: { margin: 0, maxHeight: 60, overflow: "auto", wordBreak: "break-word" } },
              selection.text),
            h("div", { className: "pt-toolbar" },
              h("input", {
                className: "pt-input pt-toolbar-grow",
                value: question, placeholder: t("askPlaceholder"), "aria-label": t("askPlaceholder"),
                onChange: (event) => setQuestion(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") {
                    // askSelection is async now (it fetches the anchored packet from the
                    // Host); swallowing the promise keeps an unhandled rejection out of
                    // the console without hiding errors, which the callback reports.
                    void askSelection();
                  }
                },
              }),
              h(Button, { variant: "primary", onClick: () => { void askSelection(); }, disabled: !inputActions || busy !== null }, t("ask")),
              h(Button, { onClick: saveEvidence, disabled: busy !== null }, t("evidence")),
            ),
            // Write-back panel: appears once a question was actually inserted, because
            // writing an answer back needs a packet — a page and character anchor — to
            // attach to. Without one this would be a text box with nowhere to put the
            // result, which is how "answers never come back" happened before.
            lastAsk !== null ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6, paddingTop: 4 } },
              h("div", { className: "pt-caption" }, `${t("answerPanelTitle")} · ${t("page")} ${lastAsk.selection.pageIndex + 1}${lastAsk.selection.anchored ? ` · ${lastAsk.selection.charStart}-${lastAsk.selection.charEnd}` : ` · ${t("askAnchorMissing")}`}`),
              h("textarea", {
                className: "pt-input",
                value: answerText,
                placeholder: t("answerPlaceholder"),
                "aria-label": t("answerPlaceholder"),
                rows: 3,
                style: { resize: "vertical", width: "100%", boxSizing: "border-box" },
                onChange: (event) => setAnswerText(event.target.value),
              }),
              h("div", { className: "pt-toolbar" },
                // A note always works; evidence additionally needs the source quote,
                // which the packet carries — so the button is enabled either way and
                // the Host refuses with a named reason if the quote is missing.
                h(Button, { onClick: () => { void saveAnswer("note"); }, disabled: busy !== null }, t("saveAnswerNote")),
                h(Button, { variant: "primary", onClick: () => { void saveAnswer("evidence"); }, disabled: busy !== null || !lastAsk.selection.anchored }, t("saveAnswerEvidence")),
                h(Button, { onClick: () => { setLastAsk(null); setAnswerText(""); }, disabled: busy !== null }, t("dismiss")),
              )) : null,
            // Annotation controls, kept below the evidence/ask row on purpose: saving a
            // highlight is the low-commitment action, and putting it beside "evidence"
            // is exactly how the two concepts got confused in the first place.
            h("div", { className: "pt-toolbar" },
              h("input", {
                className: "pt-input pt-toolbar-grow",
                value: annotationNote,
                placeholder: t("annotateNote"),
                "aria-label": t("annotateNote"),
                onChange: (event) => setAnnotationNote(event.target.value),
              }),
              h(Button, {
                onClick: async () => {
                  const result = await saveAnnotation({
                    quote: selection.text,
                    note: annotationNote,
                    pageIndex: selection.pageIndex,
                  });
                  if (result?.ok) {
                    setAnnotationNote("");
                    setAnnotationMessage(t("annotationSaved"));
                  } else {
                    setAnnotationMessage(result?.reason ?? t("annotationSaved"));
                  }
                },
                disabled: busy !== null,
              }, t("annotate")),
            ),
            annotationMessage !== "" ? h("p", { className: "pt-caption", style: { margin: 0 } }, annotationMessage) : null,
            h("p", { className: "pt-caption", style: { margin: 0 } }, t("askHint")),
          ),
        ) : null,

        // The annotation list is rendered whenever a paper is open, not only when a
        // selection exists: its purpose is to show what the reader has already marked,
        // which is exactly the moment there is no selection.
        reader ? h("div", { style: { padding: "8px 12px 0", display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { className: "pt-toolbar" },
            h("span", { className: "pt-h2" }, `${t("annotationList")} · ${annotations.length}`),
            h("div", { className: "pt-spacer" }),
            h(Button, { onClick: loadAnnotations, disabled: busy !== null }, "↻"),
          ),
          annotations.length === 0
            ? h("p", { className: "pt-caption", style: { margin: 0 } }, t("annotationNone"))
            : h("ul", { className: "pt-list" }, annotations.map((annotation) => h("li", {
              key: annotation.annotationId,
              className: "pt-card",
              style: { display: "flex", flexDirection: "column", gap: 4 },
            },
              h("div", { className: "pt-caption" },
                `${t("page")} ${annotation.pageIndex + 1}` +
                  (annotation.tags.length > 0 ? ` · ${annotation.tags.join(" / ")}` : "")),
              annotation.quote !== ""
                ? h("p", { className: "pt-body", style: { margin: 0, wordBreak: "break-word" } }, annotation.quote)
                : null,
              annotation.note !== ""
                ? h("p", { className: "pt-caption", style: { margin: 0, wordBreak: "break-word" } }, annotation.note)
                : null,
              h("div", { className: "pt-toolbar" },
                // Promoting is offered but only works for an annotation that actually
                // quotes something; the host refuses the rest and explains why.
                h(Button, {
                  disabled: busy !== null,
                  onClick: async () => {
                    const result = await callRemote(sessionId, "promoteAnnotation", {
                      annotationId: annotation.annotationId,
                    }).catch((promoteError) => ({ ok: false, reason: promoteError?.message ?? "" }));
                    setAnnotationMessage(result?.ok ? t("annotationSaved") : (result?.reason ?? ""));
                    if (result?.ok) await loadEvidence();
                  },
                }, t("annotationPromote")),
                h("div", { className: "pt-spacer" }),
                h(Button, {
                  disabled: busy !== null,
                  onClick: async () => {
                    await removeAnnotation(annotation.annotationId);
                  },
                }, t("annotationDelete")),
              ),
            ))),
        ) : null,

        candidates !== null ? h("div", { style: { padding: "10px 12px 0", display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { className: "pt-toolbar" },
            h("span", { className: "pt-h2" },
              `${mode === "cnki" ? t("cnki") : t("external")} · ${candidates.length}`),
            h("div", { className: "pt-spacer" }),
            h(Button, {
              variant: "primary",
              disabled: busy !== null || !candidates.some((_candidate, index) => picked[index]),
              onClick: addPicked,
            }, busy === "add" ? t("downloading") : t("addSelected")),
          ),
          mode === "external" ? h("p", { className: "pt-caption", style: { margin: 0 } }, t("metadataOnlyNote")) : null,
          candidates.length === 0
            ? h(Empty, { title: t("noCandidates") })
            : h("ul", { className: "pt-list" }, candidates.map((candidate, index) => h("li", {
              key: `${candidate.doi || candidate.title}-${index}`,
            },
              h("label", { className: "pt-card", style: { display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" } },
                h("input", {
                  type: "checkbox", checked: picked[index] === true,
                  style: { marginTop: 3 },
                  onChange: (event) => setPicked((current) => ({ ...current, [index]: event.target.checked })),
                }),
                h("span", { className: "pt-row-main" },
                  h("span", { className: "pt-h2", style: { display: "block", color: "var(--dsw-alias-label-primary)", wordBreak: "break-word" } }, candidate.title),
                  h("span", { className: "pt-meta", style: { display: "block", marginTop: 2 } },
                    [candidate.authors, candidate.year, candidate.venue, candidate.source, candidate.doi].filter(Boolean).join(" · ")),
                  candidate.abstract
                    ? h("span", { className: "pt-meta", style: { display: "block", marginTop: 4 } }, candidate.abstract.slice(0, 220))
                    : null,
                ),
              ),
            ))),
        ) : null,

        reader ? null : h("div", { style: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { className: "pt-toolbar" },
            h("span", { className: "pt-caption pt-num" }, hits !== null
              ? `${hits.length} ${t("total")}`
              : t("statusLine", {
                papers: papers.length,
                pages: status?.library?.pages ?? 0,
                evidence: status?.library?.evidence ?? 0,
              })),
            h("div", { className: "pt-spacer" }),
            h(Button, { variant: "ghost", onClick: refresh, disabled: busy !== null }, t("reload")),
          ),
          list.length === 0
            ? (hits !== null
              ? h(Empty, { title: t("noResults"), hint: t("noResultsHint") })
              : h(Empty, {
                title: t("empty"),
                hint: t("emptyHint"),
                action: h(Button, { variant: "primary", onClick: () => fileInputRef.current?.click() }, t("import")),
              }))
            : h("ul", { className: "pt-list" }, list.map((paper) => h(PaperCard, {
              key: paper.paperId,
              paper,
              t,
              busy,
              onOpen: openReader,
              onEdit: setEditing,
              onReextract: reextractOne,
              onEnrich: enrichOne,
              onReocr: reocrOne,
              onDelete: deletePaper,
            }))),
        ),
      );

      const renderEvidence = () => {
        const evidenceList = evidenceGroups.length === 0
          ? h(Empty, { title: t("noResults") })
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
            evidenceGroups.map(([paperId, rows]) => h("section", { key: paperId },
              h("div", { className: "pt-toolbar", style: { marginBottom: 2 } },
                h("span", { className: "pt-h2", style: { flex: 1, minWidth: 0, wordBreak: "break-word" } },
                  rows[0].paperTitle || paperId),
                h("span", { className: "pt-caption pt-num" }, `${rows.length}`),
              ),
              h("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l1)" } },
                rows.map((row) => h(EvidenceRow, {
                  key: row.evidenceId, row, t, busy,
                  onJump: jumpToEvidence,
                  onDelete: removeEvidence,
                })),
              ),
            )),
          );

        const filterBar = h("div", { className: "pt-toolbar" },
          h("span", { className: "pt-caption pt-num" },
            `${evidenceGroups.length} ${t("paperCount")} · ${evidence.length} ${t("evidenceCount")} · ${locatedEvidence.length} ${t("anchoredCount")}`),
          h("div", { className: "pt-spacer" }),
          h(Button, {
            variant: evidenceFilter === "all" ? "primary" : "ghost",
            onClick: () => setEvidenceFilter("all"),
          }, t("filterAll")),
          h(Button, {
            variant: evidenceFilter === "anchored" ? "primary" : "ghost",
            onClick: () => setEvidenceFilter("anchored"),
          }, `${t("filterAnchored")} ${locatedEvidence.length}`),
          excludedCount > 0 ? h(Button, {
            variant: evidenceFilter === "unanchored" ? "primary" : "ghost",
            onClick: () => setEvidenceFilter("unanchored"),
          }, `${t("filterUnanchored")} ${excludedCount}`) : null,
        );

        const evidenceBody = evidence.length === 0
          ? h(Empty, { title: t("evidenceEmpty"), hint: t("evidenceEmptyHint") })
          : h(React.Fragment, null, filterBar, evidenceList);

        return h("div", { style: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 10 } },
        h("div", { className: "pt-toolbar" },
          h("input", {
            className: "pt-input pt-toolbar-grow",
            value: collectQuery, placeholder: t("collectPlaceholder"), "aria-label": t("collectPlaceholder"),
            onChange: (event) => setCollectQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") collectEvidence(); },
          }),
          h(Button, { variant: "primary", onClick: collectEvidence, disabled: busy !== null || collectQuery.trim() === "" },
            t("collect")),
        ),
        h("p", { className: "pt-caption", style: { margin: 0 } }, t("collectHint")),
        evidenceBody,

        h("hr", { className: "pt-divider" }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { className: "pt-toolbar" },
            h("span", { className: "pt-h2" }, t("matrix")),
            h("div", { className: "pt-spacer" }),
            h(Button, { variant: "ghost", onClick: () => checkMatrix(""), disabled: busy !== null }, t("coverage")),
          ),
          h("div", { className: "pt-toolbar" },
            h("input", {
              className: "pt-input pt-toolbar-grow",
              value: matrixClaim, placeholder: t("claimPlaceholder"), "aria-label": t("claimPlaceholder"),
              onChange: (event) => setMatrixClaim(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") checkMatrix(matrixClaim); },
            }),
            h(Button, { variant: "primary", onClick: () => checkMatrix(matrixClaim), disabled: busy !== null },
              busy === "matrix" ? t("searching") : t("checkStance")),
          ),
          matrix ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            matrix.text ? h("p", { className: "pt-meta", style: { margin: 0 } }, matrix.text.split("\n").slice(0, 2).join(" ")) : null,
            (matrix.rows ?? []).length === 0
              ? h(Empty, { title: t("noResults") })
              : h("ul", { className: "pt-list" }, matrix.rows.map((row) => {
                const jumpId = row.evidenceIds?.[0] ?? row.notFoundEvidenceIds?.[0] ?? null;
                const target = jumpId === null ? null : evidence.find((item) => item.evidenceId === jumpId);
                return h("li", { key: row.paperId, className: "pt-card" },
                  h("div", { style: { display: "flex", gap: 6, alignItems: "flex-start" } },
                    h("span", { className: "pt-body", style: { flex: 1, minWidth: 0, wordBreak: "break-word" } }, row.title),
                    h(StanceBadge, { stance: row.stance, t }),
                  ),
                  h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
                    h("span", { className: "pt-caption pt-num" },
                      `+${row.supportCount ?? 0} · −${row.conflictCount ?? 0} · ?${row.notFoundCount ?? 0}`),
                    h("div", { className: "pt-spacer" }),
                    target !== undefined ? h(Button, {
                      variant: "ghost", icon: true, label: t("jumpToPage"),
                      onClick: () => jumpToEvidence(target),
                    }, "↗") : null,
                  ),
                );
              })),
          ) : null,
        ),
      );
      };

      const renderReview = () => h("div", { style: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 10 } },
        h("div", { className: "pt-toolbar" },
          h("span", { className: "pt-h2" }, t("outline")),
          h("div", { className: "pt-spacer" }),
          h(Button, { onClick: buildOutline, disabled: busy !== null }, t("generateOutline")),
          outline?.text ? h(Button, { onClick: sendOutline, disabled: !inputActions, variant: "primary" }, t("sendToChat")) : null,
        ),
        outline
          ? h("pre", { className: "pt-pre" }, outline.text)
          : h(Empty, { title: t("selectEvidence") }),

        h("hr", { className: "pt-divider" }),

        h("div", { className: "pt-toolbar" },
          h("span", { className: "pt-h2" }, t("citations")),
        ),
        h("div", { className: "pt-toolbar" },
          h("label", { style: { display: "flex", gap: 4, alignItems: "center" } },
            h("span", { className: "pt-caption" }, t("style")),
            h("select", {
              className: "pt-select", style: { width: "auto", minWidth: 110 },
              value: citationStyle, "aria-label": t("style"),
              onChange: (event) => setCitationStyle(event.target.value),
            }, (status?.styles ?? ["apa", "ieee", "gb-t-7714"]).map((style) => h("option", { key: style, value: style }, style))),
          ),
          h("label", { style: { display: "flex", gap: 4, alignItems: "center" } },
            h("span", { className: "pt-caption" }, t("locale")),
            h("select", {
              className: "pt-select", style: { width: "auto", minWidth: 80 },
              value: citationLocale, "aria-label": t("locale"),
              onChange: (event) => setCitationLocale(event.target.value),
            },
              h("option", { value: "zh-CN" }, "zh-CN"),
              h("option", { value: "en-US" }, "en-US"),
            ),
          ),
          h("div", { className: "pt-spacer" }),
          h(Button, { variant: "primary", onClick: renderCitations, disabled: busy !== null || locatedEvidence.length === 0 },
            busy === "citations" ? t("searching") : t("generateCitations")),
        ),
        h("p", { className: "pt-caption", style: { margin: 0 } },
          locatedEvidence.length === 0
            ? t("noEvidence")
            : `${locatedEvidence.length} ${t("evidenceCount")} · ${t("anchoredCount")}${excludedCount > 0 ? ` · ${t("unlocatedExcluded", { n: excludedCount })}` : ""}`),

        citation?.ok
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("span", { className: "pt-caption" }, t("inText")),
            h("pre", { className: "pt-pre", style: { maxHeight: "16vh" } }, citation.citation),
            h("span", { className: "pt-caption" }, t("bibliography")),
            h("pre", { className: "pt-pre" }, citation.bibliography),
            citation.warnings?.length > 0
              ? h("p", { className: "pt-caption", style: { margin: 0 } }, citation.warnings.join(" · "))
              : null,
          )
          : citation && citation.ok === false
            ? h(Banner, { tone: "error" }, citation.text ?? "citation failed")
            : null,

        h("div", { className: "pt-toolbar" },
          h(Button, {
            variant: "primary", onClick: doExport,
            disabled: busy !== null || locatedEvidence.length === 0,
          }, busy === "export" ? t("exporting") : t("export")),
          h(Button, { onClick: copyMarkdown, disabled: !exported?.markdown && !citation?.bibliography }, t("copy")),
        ),

        exported?.ok
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("p", { className: "pt-meta", style: { margin: 0, wordBreak: "break-all" } },
              `${t("exported")} · ${exported.paths?.dir ?? ""}`),
            exported.warnings?.length > 0
              ? h("div", null,
                h("p", { className: "pt-caption", style: { margin: "0 0 2px" } }, t("warnings")),
                h("ul", { className: "pt-list" }, exported.warnings.map((warning, index) => h("li", {
                  key: index, className: "pt-meta",
                }, `· ${warning}`))),
              )
              : h("p", { className: "pt-caption", style: { margin: 0 } }, t("noWarnings")),
          )
          : null,
      );

      const tabs = [
        ["library", t("library"), counts.library],
        ["evidence", t("evidenceTab"), counts.evidence],
        ["review", t("reviewTab"), null],
      ];
      return h("div", { className: "pt-root", "data-paper-tool": view },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px 6px" } },
          h("span", { className: "pt-h1" }, t("title")),
          h("span", { className: "pt-caption pt-num", style: { flex: 1, minWidth: 0 } },
            t("statusLine", {
              papers: libraryCount,
              pages: status?.library?.pages ?? 0,
              evidence: status?.library?.evidence ?? 0,
            })),
          h(Button, { variant: "ghost", icon: true, label: t("reload"), onClick: refresh, disabled: busy !== null }, "⟳"),
        ),
        h("div", { className: "pt-tabs", role: "tablist" },
          tabs.map(([id, label, count]) => h("button", {
            key: id,
            type: "button",
            role: "tab",
            className: "pt-tab",
            "aria-selected": view === id ? "true" : "false",
            onClick: () => setView(id),
          }, label, count === null || count === undefined
            ? null
            : h("span", { className: "pt-tab-count" }, ` ${count}`))),
        ),
        error ? h("div", { style: { padding: "8px 12px 0" } },
          h(Banner, {
            tone: "error", title: t("errorTitle"), children: error,
            onDismiss: () => setError(null), dismissLabel: t("dismiss"),
          })) : null,
        note ? h("div", { style: { padding: "8px 12px 0" } },
          h(Banner, { tone: "note" }, note)) : null,
        // The busy row exists so a long job is distinguishable from a frozen UI: it
        // names the stage and offers the one control that matters while waiting.
        // Before this, `busy` only disabled buttons — a user watching a 40-page OCR
        // run had no text and no way out.
        busy !== null ? h("div", { style: { padding: "8px 12px 0" } },
          h("div", {
            className: "pt-well",
            style: { padding: "6px 10px", display: "flex", alignItems: "center", gap: 8 },
            role: "status",
            "aria-live": "polite",
          },
            h("span", { className: "pt-meta pt-num" }, `${busyStage !== "" ? busyStage : busy}…`),
            h("div", { className: "pt-spacer" }),
            abortRef.current !== null
              ? h(Button, { onClick: cancelBusy, label: t("cancelBusy") }, t("cancel"))
              : null,
          )) : null,
        cancelMessage !== "" ? h("div", { style: { padding: "8px 12px 0" } },
          h(Banner, {
            tone: "note", children: cancelMessage,
            onDismiss: () => setCancelMessage(""), dismissLabel: t("dismiss"),
          })) : null,
        h("div", { style: { flex: "1 1 auto", minHeight: 0, overflow: "auto" } },
          // Keyed by view so a crash in one tab does not leave the other tabs
          // showing a stale error, and so switching tabs clears the failure.
          h(ViewBoundary, { key: view, t },
            view === "library" ? renderLibrary() : view === "evidence" ? renderEvidence() : renderReview()),
        ),
      );
    }

    /**
     * Isolate the right-column integration behind its own dependency gate.
     *
     * Cordis gates activation wholesale: a plugin whose declared `inject`
     * includes a service the running build does not provide is marked inactive
     * and never activates (`Fiber._refresh` reports INACTIVE on the first missing
     * name), and there is no per-service "optional" marker. So `inject` here
     * lists only what every supported DSH build has, and the right column is
     * mounted in a child fiber that declares its own dependencies. On a build
     * that lacks them only this child stays inactive — the dictionaries, the CSS
     * and the rest of the plugin still load, and the failure is a missing
     * feature instead of a missing plugin.
     *
     * The name list covers both the current shape (`sidebarRightTabs` +
     * `sidebarRight` + the keyed tab slot's owning services) and the older
     * details-column builds, because an unused name only gates this child.
     */
    const RIGHT_COLUMN_DEPS = ["slots", "sidebarRightTabs", "sidebarRight"];

    /** Register the tab type, its body and the first-run reveal. */
    function applyRightColumn(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: KIND,
        title: () => t("title"),
        keepMounted: true,
        guide: [{ id: "paper-tool", order: 50, title: () => t("title"), description: () => t("guide.description") }],
      }), "paper-tool: tab type");
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: TAB_ID,
        locale: NS,
      }, Body)), "paper-tool: tab body");
      ctx.effect(() => revealLibraryTab(ctx), "paper-tool: reveal the library tab");
    }

    function apply(ctx) {
      sharedCtx = ctx;
      ensureCss();
      ctx.effect(() => ctx.locale.register(NS, DICTS));
      // Registering a tab TYPE only makes the type available; it never opens a
      // tab and never expands the column, and a collapsed column draws no rail
      // at all — so on a fresh profile the plugin is invisible until the user
      // finds the corner toggle or the Ctrl+Alt+B shortcut. Opening it once is
      // part of `applyRightColumn`, which runs only where the column exists.
      if (typeof ctx.inject === "function") {
        ctx.inject(RIGHT_COLUMN_DEPS, (scope) => {
          applyRightColumn(scope);
        });
        return;
      }
      // No child-fiber support: fall back to probing, so a build with the column
      // still gets it and a build without it does not throw.
      if (typeof ctx.sidebarRightTabs?.register === "function") applyRightColumn(ctx);
    }

    /**
     * Put the workbench on screen the first time a Session with an empty,
     * collapsed right column is up.
     *
     * `ctx.sidebarRight.openTab` throws unless a Session is on screen *and* its
     * surface is committed, which is never true while `apply()` runs. The
     * controller's `mounted` store names the on-screen Session, so the trigger
     * is its subscription rather than a fixed delay; the surface can still land
     * one commit later, so a short bounded retry covers that gap.
     *
     * Deliberately conservative: a column that already holds tabs, or that the
     * user has expanded (they have therefore seen the guide card), is left
     * untouched. Each Session is decided about at most once per page load, so
     * switching back to a Session whose tab the user closed does not reopen it.
     */
    function revealLibraryTab(ctx) {
      const right = ctx.sidebarRight;
      const mounted = right?.mounted;
      if (typeof mounted?.subscribe !== "function") return () => {};
      const RETRY_MS = 100;
      const RETRY_LIMIT = 40;
      // Sessions this page load has already decided about. Per Session rather
      // than global: the column's layout is per Session, so opening a second
      // Session must be able to reveal the workbench there too.
      const settled = new Set();
      let timer = null;

      const clearTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };

      /** @returns whether this attempt is final for the on-screen Session. */
      const tryOnce = () => {
        let screen;
        try {
          screen = right.screen();
        } catch {
          return false;
        }
        if (screen === undefined) return false;
        const { sessionId } = screen;
        if (settled.has(sessionId)) return true;
        const layout = screen.surface?.layout;
        const tabs = Object.values(layout?.tabs ?? {});
        // Someone else's arrangement, or a column the user already expanded:
        // not ours to change.
        if (tabs.length > 0 || layout?.expanded === true) {
          settled.add(sessionId);
          return true;
        }
        try {
          right.openTab(KIND);
          settled.add(sessionId);
          return true;
        } catch {
          // Leave the Session unsettled so the next tick retries: `mounted` can
          // name the Session before its store is adopted. Never let the throw
          // escape — the type and the body are registered either way, so the
          // guide card and the corner toggle still open it by hand.
          return false;
        }
      };

      const attempt = () => {
        clearTimer();
        let tries = 0;
        const step = () => {
          timer = null;
          const done = tryOnce();
          tries += 1;
          if (!done && tries < RETRY_LIMIT) timer = setTimeout(step, RETRY_MS);
        };
        step();
      };

      const unsubscribe = mounted.subscribe(attempt);
      attempt();
      return () => {
        unsubscribe();
        clearTimer();
        settled.clear();
      };
    }

    return {
      // Declared dependencies gate activation wholesale: cordis marks a plugin
      // INACTIVE when any injected service is missing (`Fiber._refresh`), and
      // there is no per-service "optional" marker. So only services every
      // supported DSH build provides are listed here; the right column is probed
      // at activation time instead (see `capabilities`). Listing
      // `sidebarRightTabs`/`sidebarRight` here is what made a build without them
      // report "1 entry did not activate" and take the whole panel with it.
      inject: ["locale", "slots", "connection"],
      apply,
      // Surfaced for test/ui-render.mjs, which renders each view through
      // react-dom/server. The loader only reads `inject` and `apply`, so this
      // extra key is inert at runtime; it exists because a render error in a
      // view the user has not opened yet is otherwise invisible to every test.
      __test: { Body, PdfReader, PaperCard, MetadataEditor, EvidenceRow, StanceBadge, ViewBoundary, snippetNodes, CSS, DICTS },
    };
  },
});

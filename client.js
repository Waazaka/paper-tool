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
    const MAX_PDF_BYTES_FALLBACK = 64 * 1024 * 1024;
    const MAX_QUOTE_CHARS = 500;
    // Fallback only. The authoritative limits come from `status` (Host-side
// `MAX_IMPORT_FILES` / `MAX_PDF_BYTES`): a copy here drifts, and drift between
// the two means "client lets it through, Host rejects it" with no way to tell
// which number was real. This value is used only before the first status reply.
const MAX_IMPORT_FILES_FALLBACK = 32;

    // One page of the sidebar list. The Host accepts up to 500, which is why the
    // old client asked for all 500 and could never see row 501; a page this small
    // keeps the first paint cheap, and "load more" grows it on demand.
    const PAPER_PAGE_SIZE = 50;
    const EVIDENCE_PAGE_SIZE = 50;

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
  citationCount: "{n} 次引用",
  sortBy: "排序方式",
  sortRelevance: "相关度",
  sortCitations: "被引最多",
  sortYear: "最新",
  loadMore: "加载更多（已显示 {shown} / {total}）",
  loadedOf: "已显示 {shown} / {total} 篇",
  loadingMore: "加载中…",
  evidenceLoadMore: "加载更多证据（已显示 {shown} / {total}）",
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
        backupTitle: "备份与迁移",
        backupNow: "备份整库",
        backingUp: "备份中…",
        backupLoading: "正在读取库大小…",
        backupSummary: "当前库：{db} 索引 + {files}（{n} 个 PDF）",
        backupLivesAt: "备份写到",
        backupWalNote: "备份用 VACUUM INTO 生成一致性快照，不是直接拷文件——库在 WAL 模式下直接拷会漏掉最近提交。",
        backupNone: "还没有备份。",
        backupExisting: "已有备份",
        backupDone: "备份完成",
        backupIncomplete: "备份不完整",
        restore: "恢复",
        restoring: "恢复中…",
        restoreDone: "恢复完成",
        restoreForce: "允许覆盖",
        restoreForceWarning: "将覆盖当前库",
        restoreForceDetail: "目标位置已有论文。勾选「允许覆盖」后再点恢复，现有库会被备份内容替换且无法撤销。",
        pathsRewritten: "条路径已重写",
        restoreMissingPdf: "以下论文的 PDF 未随备份恢复",
        refresh: "刷新",
        compareAdd: "加入比较",
        compareHint: "与已打开的论文并排阅读（最多 3 篇）",
        compareSet: "比较",
        compareClear: "全部关闭",
        compareClose: "关闭这一篇",
        compareFocused: "当前",
        compareFromMatrix: "与当前论文并排",
        compareJump: "跳到各篇对应处",
        compareJumpHint: "把其他面板移到同一论断的对应证据",
        compareJumped: "已在 {count} 个面板中定位到对应证据",
        compareNoMatch: "这篇的同一论断在已加载证据里没找到对应段落，面板未移动。",
        compareRestored: "已恢复上次的比较组合",
        topicsTab: "选题",
        topicRecommend: "生成素材",
        topicWorking: "检索中…",
        topicPlaceholder: "领域关键词，例如 deep learning in education",
        topicIntro: "插件不替你选题：它检索外部源、统计年度分布与标题共现，把素材摆在下面，由你在对话里判断。",
        topicDisclaimer: "下面的数字是标题词频与共现计数，不是研究结论。创新性与可行性需你自己判断。",
        topicSample: "有效样本",
        topicPapers: "篇",
        topicUndated: "篇年份缺失",
        topicMinSample: "最低样本",
        topicInsufficient: "样本不足",
        topicTrend: "年度分布",
        topicDirection: "方向",
        topicDir_rising: "上升",
        topicDir_falling: "下降",
        topicDir_flat: "平稳",
        topicGaps: "共现组合（可能的研究缺口）",
        topicCoOccur: "共现",
        topicIndependent: "各自独立出现",
        topicCandidates: "条候选",
        topicQuestion: "研究问题",
        topicFeasibility: "可行性依据",
        topicInnovation: "缺口依据",
        topicRepresentatives: "高引代表",
        topicFound: "已统计",
        topicSourceFailures: "失败的数据源",
        translateTab: "对照",
        translateIntro: "插件不翻译：它把原文切段并带上页码锚点，由对话里的 Agent 翻译，再把译文按锚点写回。",
        translatePaper: "选择论文",
        translatePickPaper: "选择一篇论文",
        translateFrom: "从第",
        translateTo: "到第",
        translateInto: "译为",
        loadSegments: "取分段",
        loadingSegments: "取分段中…",
        saveTranslation: "保存译文",
        saving: "保存中…",
        segmentCount: "段",
        translatedCount: "已译",
        untranslatedCount: "未译",
        translatedCountShort: "已译",
        translationSaved: "段译文已保存",
        translationRejected: "段被拒绝",
        noTranslationEntered: "没有填写任何译文",
        translateEmpty: "先选一篇论文并点「取分段」",
        translateSourceCol: "原文（带锚点）",
        translateTargetCol: "译文",
        translateSegmentAria: "第 {page} 页 {start} 处的译文",
        alignedAll: "全部对齐",
        alignedPartly: "还有 {n} 段未译",
        translateOcrNote: "{n} 页原文来自 OCR，译文会继承识别错误",
        translateOcrCaveat: "原文来自 OCR，译文可能继承识别错误",
        importFolder: "选目录",
        noPdfFound: "没有找到 PDF 文件",
        dropToImport: "松开即入库",
        importLeftover: "另有 {n} 个文件超出单次上限 {limit}，未处理",
        importTooLargeSkipped: "{n} 个文件超过 {limit} MB，已跳过",
        watch: "监目录",
        watchOn: "监目录已开",
        watchOff: "监目录已关",
        watchPick: "选择监听目录",
        watchHint: "只在你开启后监听；新 PDF 掉进目录会自动入库",
        watchRoot: "监听中：{dir}",
        watchNeedsPath: "无法取得目录的绝对路径：请在系统文件对话框里选择，或手动开启监目录",
        watchNoDir: "未选择目录",
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
  gradeStrong: "强",
  gradePartial: "部分",
  gradeWeak: "弱",
        covered: "有证据",
        emptyCoverage: "无证据",
        jumpToPage: "跳转",
        review: "综述材料",
        outline: "证据大纲",
        generateOutline: "生成大纲",
        // 章节骨架与证据大纲是两个产出（D-016）：一个按论文列材料，一个按章节分材料。
        skeleton: "章节骨架",
        buildSkeleton: "生成章节骨架",
        skeletonHint: "按论文列材料是上面的证据大纲；这里是把材料分到章节里，每章给出应引用的证据。",
        skeletonBinds: "本章应引用",
        unknownPaper: "（论文标题缺失）",
        citeImport: "导入 .bib / .ris",
        citeImportHint: "从 Zotero / EndNote / Mendeley 导出引用文件后在这里导入，条目以仅元数据状态入库。",
        citeImportPick: "选择引用文件",
        citeImportDone: "导入完成",
        citeImportEmpty: "还没有导入。",
        similar: "库内重叠提示",
        similarHint: "只与你库里已存的证据比对，用来发现自己是否在重复引用同一批材料；不联网、不给分数、不是查重率。",
        similarCheck: "检查重叠",
        similarPlaceholder: "粘贴一段你写的文字…",
        similarHits: "重叠条目",
        similarDisclosure: "仅作辅助：不评判原创性，不是查重率。",
        similarNoEvidence: "库里还没有证据，先到阅读器里把要点存成证据。",
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
  citationCount: "{n} citations",
  sortBy: "Sort by",
  sortRelevance: "Relevance",
  sortCitations: "Most cited",
  sortYear: "Newest",
  loadMore: "Load more ({shown} of {total} shown)",
  loadedOf: "{shown} of {total} papers shown",
  loadingMore: "Loading…",
  evidenceLoadMore: "Load more evidence ({shown} of {total} shown)",
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
        backupTitle: "Backup",
        backupNow: "Back up library",
        backingUp: "Backing up…",
        backupLoading: "Reading library size…",
        backupSummary: "Library: {db} index + {files} ({n} PDFs)",
        backupLivesAt: "Backups go to",
        backupWalNote: "The snapshot uses VACUUM INTO, not a file copy — in WAL mode a plain copy can miss recent commits.",
        backupNone: "No backups yet.",
        backupExisting: "Existing backups",
        backupDone: "Backup complete",
        backupIncomplete: "Backup incomplete",
        restore: "Restore",
        restoring: "Restoring…",
        restoreDone: "Restore complete",
        restoreForce: "Allow overwrite",
        restoreForceWarning: "This will overwrite the library",
        restoreForceDetail: "The target already holds papers. Tick “allow overwrite” and restore again; the current library is replaced and cannot be undone.",
        pathsRewritten: "path(s) rewritten",
        restoreMissingPdf: "PDFs missing after restore",
        refresh: "Refresh",
        compareAdd: "Compare",
        compareHint: "Read beside an already-open paper (up to 3)",
        compareSet: "Comparing",
        compareClear: "Close all",
        compareClose: "Close this one",
        compareFocused: "focused",
        compareFromMatrix: "Side by side with current",
        compareJump: "Jump panes to match",
        compareJumpHint: "Move the other panes to this claim's matching evidence",
        compareJumped: "Located matching evidence in {count} pane(s)",
        compareNoMatch: "No stored evidence for this claim in the loaded rows; panes were not moved.",
        compareRestored: "Restored the previous comparison",
        topicsTab: "Topics",
        topicRecommend: "Gather material",
        topicWorking: "Searching…",
        topicPlaceholder: "Field keywords, e.g. deep learning in education",
        topicIntro: "The plugin does not pick your topic: it queries external sources, counts years and title co-occurrence, and lays the material out here for you to judge.",
        topicDisclaimer: "The numbers below are title word counts and co-occurrence, not research conclusions. Judge novelty and feasibility yourself.",
        topicSample: "usable sample",
        topicPapers: "papers",
        topicUndated: "undated",
        topicMinSample: "minimum sample",
        topicInsufficient: "Insufficient sample",
        topicTrend: "Papers per year",
        topicDirection: "direction",
        topicDir_rising: "rising",
        topicDir_falling: "falling",
        topicDir_flat: "flat",
        topicGaps: "Co-occurring pairs (possible gaps)",
        topicCoOccur: "co-occurs",
        topicIndependent: "independent",
        topicCandidates: "candidates",
        topicQuestion: "Question",
        topicFeasibility: "Feasibility basis",
        topicInnovation: "Gap basis",
        topicRepresentatives: "Most cited",
        topicFound: "Counted",
        topicSourceFailures: "Failed sources",
        translateTab: "Translation",
        translateIntro: "The plugin does not translate: it cuts the page into anchored segments, the Agent translates them in conversation, and the result is written back by anchor.",
        translatePaper: "Paper",
        translatePickPaper: "Pick a paper",
        translateFrom: "From",
        translateTo: "To",
        translateInto: "Into",
        loadSegments: "Load segments",
        loadingSegments: "Loading…",
        saveTranslation: "Save translation",
        saving: "Saving…",
        segmentCount: "segments",
        translatedCount: "translated",
        untranslatedCount: "untranslated",
        translatedCountShort: "translated",
        translationSaved: "segment(s) saved",
        translationRejected: "rejected",
        noTranslationEntered: "No translation entered",
        translateEmpty: "Pick a paper and load its segments first",
        translateSourceCol: "Original (anchored)",
        translateTargetCol: "Translation",
        translateSegmentAria: "Translation for page {page} at {start}",
        alignedAll: "Fully aligned",
        alignedPartly: "{n} segment(s) untranslated",
        translateOcrNote: "{n} page(s) were OCR'd; the translation inherits recognition errors",
        translateOcrCaveat: "Original is OCR text; the translation may inherit recognition errors",
        importFolder: "Folder",
        noPdfFound: "No PDF files found",
        dropToImport: "Drop to import",
        importLeftover: "{n} more file(s) exceed the {limit}-file limit and were not processed",
        importTooLargeSkipped: "{n} file(s) exceed {limit} MB and were skipped",
        watch: "Watch folder",
        watchOn: "Watching",
        watchOff: "Not watching",
        watchPick: "Choose a folder to watch",
        watchHint: "Off until you turn it on; new PDFs dropped in the folder are imported",
        watchRoot: "Watching: {dir}",
        watchNeedsPath: "Could not resolve the folder's absolute path; pick it in the native dialog instead",
        watchNoDir: "No folder selected",
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
  gradeStrong: "strong",
  gradePartial: "partial",
  gradeWeak: "weak",
        covered: "covered",
        emptyCoverage: "empty",
        jumpToPage: "Open",
        review: "Review material",
        outline: "Evidence outline",
        generateOutline: "Build outline",
        skeleton: "Section skeleton",
        buildSkeleton: "Build section skeleton",
        skeletonHint: "The outline above lists material by paper; this files it into sections and names the evidence each section should cite.",
        skeletonBinds: "Should cite",
        unknownPaper: "(untitled paper)",
        citeImport: "Import .bib / .ris",
        citeImportHint: "Export from Zotero / EndNote / Mendeley, then import the file here. Entries land as metadata only.",
        citeImportPick: "Choose a citation file",
        citeImportDone: "Import finished",
        citeImportEmpty: "Nothing imported yet.",
        similar: "Overlap with library",
        similarHint: "Compares against evidence you already stored, to show when you are restating the same material. Offline, no score, not a detection rate.",
        similarCheck: "Check overlap",
        similarPlaceholder: "Paste a passage you wrote…",
        similarHits: "Overlapping rows",
        similarDisclosure: "Assistance only: no originality judgement, not a detection rate.",
        similarNoEvidence: "No evidence stored yet — save a passage as evidence in the reader first.",
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
      // watchStart takes an { dir } input object. watchStatus/watchStop take
      // nothing, so listing them would wrap an empty object for no reason.
      "watchStart",
      // Translation RPCs all take an input object.
      "translateSegments", "saveTranslation", "listTranslations", "deleteTranslation",
      // Backup RPCs: backupStatus and backupLibrary take no input, restoreLibrary
      // does, so all three go through the wrapped path.
      "backupLibrary", "restoreLibrary", "backupStatus",
      // Topic recommendation: an RPC with no tool behind it (D-014).
      "topicRecommend",
      // Writing assistance, also RPCs (D-014). All three take an input object.
      "sectionSkeleton", "importCitations", "similarityNotice",
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
          const limit = Math.round((error.details?.limit ?? MAX_PDF_BYTES_FALLBACK) / 1024 / 1024);
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
      .pt-root { position: relative; }
      .pt-table-wrap { overflow-x: auto; }
      .pt-tr-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .pt-tr-table th, .pt-tr-table td {
        text-align: left; vertical-align: top; padding: 6px 8px;
        border-top: 1px solid var(--dsw-alias-border-l1);
        word-break: break-word;
      }
      .pt-tr-table th { font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .pt-tr-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-bottom: 2px; }
      .pt-tr-caveat { font-size: 11px; margin-top: 4px; color: var(--dsw-alias-state-warn-primary); }
      /* Compare panes: stacked, and each pane is its own container so the height
     adaptation follows the pane rather than the window. min-height: 0 on every
     level is what actually prevents the overflow — a flex child defaults to
     min-height:auto and refuses to shrink below its content. */
  .pt-pane-stack {
    container-type: size;
    container-name: ptpanes;
    overflow: hidden;
  }
  .pt-pane {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
    flex: 1 1 0;
    overflow: hidden;
    border-radius: 6px;
    border: 1px solid transparent;
  }
  /* Focus is shown by a rule on the left edge, not a fill: a tinted block would
     compete with the page itself. */
  .pt-pane-focus {
    border-color: var(--dsw-alias-label-tertiary);
  }
  .pt-pane-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .pt-pane-title {
    font-size: 11px;
    font-weight: 600;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: var(--dsw-alias-label-primary);
  }
  /* Narrow or short panes hide the secondary chrome so the page keeps the space.
     scrollWidth <= clientWidth is asserted by the gate at 320-420 px. */
  @container ptpanes (max-height: 260px) {
    .pt-pane-head { display: none; }
  }
  @container ptpanes (max-width: 300px) {
    .pt-pane-title { font-size: 10px; }
  }
  .pt-tr-bar {
    display: inline-block;
    height: 8px;
    border-radius: 2px;
    background: var(--dsw-alias-brand-primary);
    opacity: 0.75;
  }
  .pt-topic-gap {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 4px 6px;
    border-radius: 4px;
    /* No fill: the pair is set off by spacing and the left rule, and a tinted
       block would compete with the candidate cards drawn in the same column. */
    background: transparent;
  }
  .pt-topic-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border-left: 2px solid var(--dsw-alias-brand-primary);
    border-radius: 4px;
    background: transparent;
  }
  .pt-tr-input {
        box-sizing: border-box; width: 100%; min-height: 62px; resize: vertical;
        font: inherit; font-size: 12px; padding: 4px 6px;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
      }
      .pt-drop-veil {
        position: absolute; inset: 0; z-index: 30;
        display: flex; align-items: center; justify-content: center;
        background: var(--dsw-alias-bg-layer-1);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, transparent);
        border: 2px dashed var(--dsw-alias-brand-primary);
        border-radius: 8px; pointer-events: none;
      }
      .pt-drop-veil-label { font-size: 13px; font-weight: 600; }
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
        /* Overflow-safe centering: justify-content:center clips the START of an
           overflowing child, so the page's right side became unreachable in a narrow
           sidebar. auto margins centre when there is room and fall back to 0 when
           there is not, keeping every edge reachable by scrolling. */
        display: flex; align-items: flex-start;
        padding: 8px;
        background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-md);
      }
      /* auto margins centre the page without clipping either edge. */
      .pt-page { position: relative; flex: none; margin: 0 auto; }
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
     *
     * `unverifiedFields` is the precomputed answer from the Host list projection
     * (PT-015 trims `metadataSource` off the list payload). The local parse is kept
     * for records that still carry the raw column — the metadata editor opens with
     * the full row from `readPaper`, which does.
     */
    function guessedFields(paper) {
      const known = ["title", "authors", "year", "venue", "doi"];
      if (Array.isArray(paper?.unverifiedFields)) return paper.unverifiedFields;
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
      if (Array.isArray(paper?.fromCrossrefFields)) return paper.fromCrossrefFields;
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

    /**
     * Scale that makes a page exactly fill the available content width.
     *
     * Extracted so the arithmetic can be tested without a browser: the caller used to
     * compute this inline against `wrap.clientWidth - 18`, and a magic 18 that does not
     * match the container's real padding is the kind of thing that silently leaves the
     * page a few pixels too wide, which then gets clipped instead of scrolled.
     */
    function fitScale({ available, pageWidth, min = 0.3, max = 3 }) {
      if (!Number.isFinite(available) || !Number.isFinite(pageWidth) || pageWidth <= 0 || available <= 0) {
        return null;
      }
      const next = available / pageWidth;
      return +Math.min(max, Math.max(min, next)).toFixed(2);
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

    function PaperCard({ paper, t, onOpen, onCompare, onEdit, onReextract, onEnrich, onReocr, onDelete, busy }) {
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
          // Compare needs a PDF for the same reason reading does: the panes render
          // pages, and a metadata-only entry would open an empty pane.
          hasPdf
            ? h(Button, {
              variant: "ghost",
              disabled: busy !== null,
              title: t("compareHint"),
              onClick: () => onCompare({
                paperId: paper.paperId,
                title: paper.title,
                pageIndex: Number.isInteger(paper.pageIndex) ? paper.pageIndex : 0,
                quote: null,
                paper,
              }),
            }, t("compareAdd"))
            : null,
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

    /** Human-readable byte size. Used by the backup panel, not for exact numbers. */
    function formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return "-";
      if (value < 1024) return `${value} B`;
      const units = ["KB", "MB", "GB", "TB"];
      let scaled = value / 1024;
      let unit = 0;
      while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit += 1; }
      return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unit]}`;
    }

    /** How long a backup took, short enough for the note line. */
    function formatDuration(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value) || value < 0) return "-";
      if (value < 1000) return `${Math.round(value)} ms`;
      return `${(value / 1000).toFixed(1)} s`;
    }

    /**
     * Join a backup directory name onto the backups root.
     *
     * Kept as a separate function because the two halves arrive from different
     * places (one from the Host, one from a list the Host produced) and a naive
     * string concatenation loses the separator on Windows.
     */
    function joinBackupPath(root, name) {
      if (typeof root !== "string" || root === "") return name;
      const separator = root.includes("\\") ? "\\" : "/";
      return `${root.replace(/[\\/]+$/, "")}${separator}${name}`;
    }

    /**
     * Where the compare set is remembered between panel mounts.
     *
     * The panel is remounted whenever the sidebar closes, so React state alone cannot
     * restore "the four papers I was comparing". A store table would be the other
     * option, but this is view state, not library data: it belongs to the window, and
     * putting it in the SQLite file would make a throwaway layout survive a backup and
     * a restore into another machine, which is wrong.
     */
    const COMPARE_STORAGE_KEY = "paper-tool.compare";

    /** Read the stored compare set, or an empty list if there is none or it is junk. */
    function readStoredCompare() {
      try {
        if (typeof localStorage === "undefined") return [];
        const raw = localStorage.getItem(COMPARE_STORAGE_KEY);
        if (typeof raw !== "string" || raw === "") return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Only the fields needed to re-open a pane. A stored row from an older version
        // with extra fields must not break the reader.
        return parsed
          .filter((row) => typeof row?.paperId === "string" && row.paperId !== "")
          .slice(0, 3)
          .map((row) => ({
            paperId: row.paperId,
            title: typeof row.title === "string" ? row.title : row.paperId,
            pageIndex: Number.isInteger(row.pageIndex) ? row.pageIndex : 0,
            quote: null,
          }));
      } catch {
        // A corrupt entry is not an error worth a banner: the user loses a layout they
        // can rebuild in one click. Silently starting empty is the correct response.
        return [];
      }
    }

    /** Write the compare set, ignoring quota or absence failures. */
    function writeStoredCompare(rows) {
      try {
        if (typeof localStorage === "undefined") return;
        if (rows.length === 0) localStorage.removeItem(COMPARE_STORAGE_KEY);
        else localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(rows.map((row) => ({
          paperId: row.paperId, title: row.title, pageIndex: row.pageIndex,
        }))));
      } catch { /* layout state is not worth failing a render over */ }
    }

    /**
     * Decide which panes a cross-paper jump would move, and where to.
     *
     * Extracted because the interesting part is the decision — "only panes that have a
     * stored row for this exact quote move"— and burying it inside a setState updater
     * leaves it testable only by driving a real text selection through a real PDF. The
     * panel and the gate now run the same function.
     *
     * @param {Array<{paperId: string, pageIndex: number}>} panes
     * @param {Array<{paperId: string, quote: string, pageIndex: number}>} rows
     * @param {string} quote
     * @returns {{moved: number, panes: Array<object>}} the new pane list and how many moved
     */
    function matchComparison(panes, rows, quote) {
      const needle = String(quote ?? "");
      const matching = needle === "" ? [] : rows.filter((row) => row.quote === needle);
      if (matching.length === 0) return { moved: 0, panes };
      const byPaper = new Map();
      for (const row of matching) {
        if (byPaper.has(row.paperId) === false) byPaper.set(row.paperId, row);
      }
      let moved = 0;
      const next = panes.map((pane) => {
        const hit = byPaper.get(pane.paperId);
        if (hit === undefined) return pane;
        moved += 1;
        return { ...pane, pageIndex: hit.pageIndex, quote: hit.quote, jumpToken: Date.now() };
      });
      return { moved, panes: next };
    }

    function PdfReader({ sessionId, paper, initialPage, highlight, jumpToken, annotations, t, onSelectionChange, onClose }) {
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

      // A repeat jump to the page already shown would otherwise be a no-op: the page
      // number does not change, so nothing re-renders and the highlight the user just
      // asked for never appears. `jumpToken` is a fresh identity per jump.
      useEffect(() => {
        if (jumpToken === undefined) return;
        setPageNumber(Math.max(1, (initialPage ?? 0) + 1));
      }, [jumpToken]);

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
          // Read the real horizontal padding instead of assuming a number: the wrap's
          // clientWidth includes padding, so subtracting a guessed constant either
          // leaves the page slightly too wide (clipped) or too narrow (wasted space).
          const style = typeof getComputedStyle === "function" ? getComputedStyle(wrap) : null;
          const padLeft = parseFloat(style?.paddingLeft ?? "0") || 0;
          const padRight = parseFloat(style?.paddingRight ?? "0") || 0;
          // The vertical scrollbar (when the page is taller than the wrap) comes out of
          // clientWidth already, so it needs no extra allowance here.
          const width = wrap.clientWidth - padLeft - padRight;
          if (!doc) return;
          doc.getPage(Math.min(pageNumber, doc.numPages || 1))
            .then((page) => {
              const base = page.getViewport({ scale: 1 });
              const next = fitScale({ available: width, pageWidth: base.width });
              if (next !== null) setScale(next);
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

    function StanceBadge({ stance, strength, t }) {
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
      // The grade rides on the badge rather than in a separate row: "支持" alone
      // was the misreading this task fixes — one hedged sentence and one firm
      // replication looked identical. No grade means no stance judgement was
      // made (coverage mode), so nothing is appended.
      const grade = strength === "strong" ? t("gradeStrong")
        : strength === "partial" ? t("gradePartial")
          : strength === "weak" ? t("gradeWeak")
            : "";
      return h(Badge, { tone: STANCE_TONE[stance] }, grade === "" ? label : `${label}·${grade}`);
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
      // How external results are ordered. Kept as state rather than read from the last
      // response so the control still reflects the user's choice while a search runs.
      const [sortMode, setSortMode] = useState("relevance");
      const [query, setQuery] = useState("");
      const [papers, setPapers] = useState([]);
      const [hits, setHits] = useState(null);
      const [candidates, setCandidates] = useState(null);
      const [picked, setPicked] = useState({});
      const [status, setStatus] = useState(null);
      const [failures, setFailures] = useState([]);
      const [cnki, setCnki] = useState(null);
      const [reader, setReader] = useState(null);
      // Compare set. The single-reader model above is kept as-is: the ordinary case
      // is reading one paper, and rebuilding that path to be a list would put the
      // lifecycle guarantees in s12/s14/s15 at risk for a feature used occasionally.
      // When a set exists the panes render instead, each an independent <PdfReader>
      // with its own document, page and zoom — which is what gives the "closing one
      // does not disturb the other" property for free rather than by bookkeeping.
      const [comparePapers, setComparePapers] = useState(() => readStoredCompare());
      const compareStackRef = useRef(null);
      // Which pane the toolbar and evidence actions apply to. Without a focus concept
      // "select text" would be ambiguous across panes.
      const [compareFocus, setCompareFocus] = useState(null);
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
      // How much evidence is loaded, and how much exists. Kept apart from
      // `evidence.length` because a full page of rows is ambiguous: it looks the
      // same whether the library has exactly one page or many.
      const [evidencePaging, setEvidencePaging] = useState({ total: 0, hasMore: false, anchoredTotal: 0, allTotal: 0 });
      // Same idea for the paper list: the sidebar asks for one page and grows it,
      // instead of requesting the 500-row ceiling and being unable to see row 501.
      // Host-declared import limits. Held in state rather than read from a
      // constant so the client and Host cannot disagree.
      const [importLimits, setImportLimits] = useState({
        maxImportFiles: MAX_IMPORT_FILES_FALLBACK,
        maxPdfBytes: MAX_PDF_BYTES_FALLBACK,
      });
      const [paperPaging, setPaperPaging] = useState({ total: 0, hasMore: false, loading: false });
      const [collectQuery, setCollectQuery] = useState("");
      const [matrixClaim, setMatrixClaim] = useState("");
      const [matrix, setMatrix] = useState(null);
      const [outline, setOutline] = useState(null);
      // Writing assistance (PT-021). All three are view state: the skeleton is a
      // proposal, the import result is a summary of what just happened, and the overlap
      // list belongs to the passage currently typed. None of it is library data, so
      // none of it goes into SQLite.
      const [skeleton, setSkeleton] = useState(null);
      const [citeImport, setCiteImport] = useState(null);
      const [similarText, setSimilarText] = useState("");
      const [similar, setSimilar] = useState(null);
      const citeImportRef = useRef(null);
      const [citationStyle, setCitationStyle] = useState("apa");
      const [citationLocale, setCitationLocale] = useState("zh-CN");
      const [citation, setCitation] = useState(null);
      const [exported, setExported] = useState(null);
      const fileInputRef = useRef(null);
      // Directory pick. `webkitdirectory` is the only way a file input can be
      // asked for a folder; it leaves `multiple` on too, so the same handler
      // receives every PDF found under the chosen tree.
      const dirInputRef = useRef(null);
      // Depth counter for dragover/dragleave. dragleave fires when the pointer
      // crosses a child element, so a boolean flag flickers; counting is the
      // standard way to know when the drag has really left the panel.
      const dragDepthRef = useRef(0);
      const [dragging, setDragging] = useState(false);
      // Watch folder state. Default {watching:false} because the Host defaults to
      // off; the UI reflects the Host rather than holding its own opinion.
      const [watchState, setWatchState] = useState(null);
      // Translation is an RPC path, not a tool (D-014): the plugin cuts the page
      // into segments and stores what comes back; the Agent writes the text.
      const [translatePaperId, setTranslatePaperId] = useState("");
      const [translateFrom, setTranslateFrom] = useState(0);
      const [translateTo, setTranslateTo] = useState(0);
      const [translateTarget, setTranslateTarget] = useState("zh");
      const [translateResult, setTranslateResult] = useState(null);
      const [translateDraft, setTranslateDraft] = useState({});
      const [translationRows, setTranslationRows] = useState([]);
      const [translateBusy, setTranslateBusy] = useState(null);
      // Backup state. The sizes come from the Host so the button can say what it
      // is about to copy instead of surprising the user with a long copy.
      const [backupStatus, setBackupStatus] = useState(null);
      const [backupResult, setBackupResult] = useState(null);
      const [backupBusy, setBackupBusy] = useState(null);
      const [restoreForce, setRestoreForce] = useState(false);
      // Topic recommendation. The result is whole-payload or null: a partial
      // recommendation would be a chart drawn from less data than it claims.
      const [topicQuery, setTopicQuery] = useState("");
      const [topicResult, setTopicResult] = useState(null);
      const [topicBusy, setTopicBusy] = useState(false);

      const openReader = useCallback((target) => {
        setReader(target);
        setSelection(null);
        setView("library");
      }, []);

      /**
       * Add a paper to the compare set, or focus it if already there.
       *
       * Capped at three: each pane holds a live PDF document and its worker, and the
       * criterion is memory staying bounded. Three is what fits in a 320-420 px
       * column as stacked panes with a usable height each.
       */
      const addToCompare = useCallback((target) => {
        if (target === null || target === undefined) return;
        setComparePapers((current) => {
          if (current.some((row) => row.paperId === target.paperId)) return current;
          if (current.length >= 3) return current;
          return [...current, target];
        });
        setCompareFocus(target.paperId);
        setReader(null);
        setSelection(null);
        setView("library");
      }, []);

      // Bring the panes into view after they mount. The effect keys off the count so it
      // runs once per add/remove, and it only scrolls when the stack is actually out of
      // view — scrolling on every add would yank the list away from someone who is
      // adding three papers in a row and already sees the stack.
      useEffect(() => {
        const node = compareStackRef.current;
        if (node === null || node === undefined) return;
        if (typeof node.getBoundingClientRect !== "function") return;
        const rect = node.getBoundingClientRect();
        const offscreen = rect.bottom < 0 || rect.top > (window.innerHeight ?? 0);
        if (!offscreen) return;
        if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start", behavior: "smooth" });
      }, [comparePapers.length]);

      const removeFromCompare = useCallback((paperId) => {
        // Both updates are computed from the same snapshot, outside each other's
        // updater. Calling setCompareFocus INSIDE the setComparePapers updater made the
        // focus update depend on when React chose to run that updater (and on how many
        // times it ran), which is exactly the kind of ordering that turns into a focus
        // pointing at a pane that is no longer on screen.
        setComparePapers((current) => {
          const remaining = current.filter((row) => row.paperId !== paperId);
          setCompareFocus((focus) => {
            if (focus !== paperId) return focus;
            const survivor = remaining[0]?.paperId ?? null;
            return survivor;
          });
          return remaining;
        });
        setSelection(null);
      }, []);

      // Persist on every change rather than on unmount: the sidebar can be closed
      // without an unmount callback firing reliably (the Host tears the column down),
      // and losing the layout on close is exactly the case this is for.
      useEffect(() => {
        writeStoredCompare(comparePapers);
      }, [comparePapers]);

      const clearCompare = useCallback(() => {
        setComparePapers([]);
        setCompareFocus(null);
        setReader(null);
        setSelection(null);
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

      /**
       * Reload the first page of evidence.
       *
       * Was `{ limit: 2000 }` — every refresh re-serialised the entire evidence
       * table over the wire, and a single new row triggered another full pass.
       * The list is paged now; the total comes back with it so the footer can say
       * how much is not yet loaded instead of implying the page is everything.
       *
       * The filter is read through a ref, not a dependency, so this callback keeps
       * one identity across a filter change. Depending on `evidenceFilter` made
       * `refresh` (which calls this) unstable, so switching the filter re-fetched
       * the paper list and annotations too — three requests to answer one click.
       * The dedicated effect below owns the filter-change refetch instead.
       */
      const evidenceFilterRef = useRef(evidenceFilter);
      evidenceFilterRef.current = evidenceFilter;
      const loadEvidence = useCallback(async () => {
        if (!sessionId) return [];
        const result = await callRemote(sessionId, "listEvidence", {
          limit: EVIDENCE_PAGE_SIZE,
          anchor: evidenceFilterRef.current,
        });
        const rows = result.evidence ?? [];
        setEvidence(rows);
        setEvidencePaging({
          total: result.paging?.total ?? rows.length,
          hasMore: result.paging?.hasMore === true,
          anchoredTotal: result.paging?.anchoredTotal ?? rows.filter((row) => row.charStart >= 0).length,
          allTotal: result.paging?.allTotal ?? rows.length,
        });
        return rows;
      }, [sessionId]);

      /** Append the next page of evidence, keeping what is already loaded. */
      const loadMoreEvidence = useCallback(async () => {
        if (!sessionId) return;
        setBusy("evidenceMore");
        try {
          const result = await callRemote(sessionId, "listEvidence", {
            limit: EVIDENCE_PAGE_SIZE,
            offset: evidence.length,
            anchor: evidenceFilterRef.current,
          });
          const rows = result.evidence ?? [];
          // Replace rather than blindly append: a row may have been deleted
          // between pages, in which case the offset has shifted and appending
          // would duplicate the tail. Deduplication by id is cheap and makes the
          // accumulated list correct regardless of what moved.
          setEvidence((current) => {
            const seen = new Set(current.map((row) => row.evidenceId));
            return [...current, ...rows.filter((row) => !seen.has(row.evidenceId))];
          });
          setEvidencePaging({
            total: result.paging?.total ?? evidence.length + rows.length,
            hasMore: result.paging?.hasMore === true,
            anchoredTotal: result.paging?.anchoredTotal ?? evidencePaging.anchoredTotal,
            allTotal: result.paging?.allTotal ?? evidencePaging.allTotal,
          });
        } catch (evidenceError) {
          setError(describeError(evidenceError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, evidence.length, evidencePaging.anchoredTotal, evidencePaging.allTotal, t]);

      /**
       * Reload evidence when the filter changes.
       *
       * The filter is a Host-side query, so changing it has to refetch rather than
       * re-render what is loaded. This effect is the only thing that reacts to the
       * filter: `loadEvidence` reads it through a ref precisely so that `refresh`
       * does not also re-run on a filter change.
       *
       * Skipped on the first run because `refresh` already loads page one —
       * without this guard every mount would fetch twice.
       */
      const evidenceFilterMounted = useRef(false);
      useEffect(() => {
        if (!evidenceFilterMounted.current) { evidenceFilterMounted.current = true; return; }
        void loadEvidence();
      }, [evidenceFilter, loadEvidence]);

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

      /**
       * Open the metadata editor for one paper.
       *
       * Fetches the full row first. The sidebar list is a projection (PT-015) that
       * omits `abstract`, and the editor has an abstract field — opening it straight
       * from the list row would show an empty box and, on save, erase the stored
       * abstract. Reading the row back is one small RPC and keeps the trim honest.
       */
      const openEditor = useCallback(async (paper) => {
        if (!sessionId) return;
        setBusy("edit");
        try {
          const full = await callRemote(sessionId, "readPaper", { paperId: paper.paperId });
          setEditing(full?.paper ?? paper);
        } catch (editError) {
          // Fall back to the list row rather than refusing to open the editor,
          // but say so: saving then would write an empty abstract over the real one.
          setError(describeError(editError, t));
          setEditing(paper);
        } finally {
          setBusy(null);
        }
      }, [sessionId, t]);

      const refresh = useCallback(async () => {
        if (!sessionId) return;
        try {
          const [state, listed] = await Promise.all([
            callRemote(sessionId, "status"),
            callRemote(sessionId, "listPapers", { limit: PAPER_PAGE_SIZE }),
          ]);
          setStatus(state);
          if (state?.limits !== undefined && state.limits !== null) {
            setImportLimits({
              maxImportFiles: Number(state.limits.maxImportFiles) || MAX_IMPORT_FILES_FALLBACK,
              maxPdfBytes: Number(state.limits.maxPdfBytes) || MAX_PDF_BYTES_FALLBACK,
            });
          }
          setPapers(listed.papers ?? []);
          setPaperPaging({
            total: listed.paging?.total ?? (listed.papers ?? []).length,
            hasMore: listed.paging?.hasMore === true,
            loading: false,
          });
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

      /**
       * Append the next page of papers.
       *
       * This is what makes paper 501 reachable at all: the old request stopped at
       * the Host's 500-row ceiling, so beyond that the sidebar simply never showed
       * the row — not slow, absent.
       *
       * Deduplicated by id on append: importing or deleting between pages shifts
       * the offsets, and a stale offset would otherwise duplicate a row.
       */
      const loadMorePapers = useCallback(async () => {
        if (!sessionId) return;
        setPaperPaging((current) => ({ ...current, loading: true }));
        try {
          const listed = await callRemote(sessionId, "listPapers", {
            limit: PAPER_PAGE_SIZE,
            offset: papers.length,
          });
          const rows = listed.papers ?? [];
          setPapers((current) => {
            const seen = new Set(current.map((paper) => paper.paperId));
            return [...current, ...rows.filter((paper) => !seen.has(paper.paperId))];
          });
          setPaperPaging({
            total: listed.paging?.total ?? papers.length + rows.length,
            hasMore: listed.paging?.hasMore === true,
            loading: false,
          });
        } catch (listError) {
          setPaperPaging((current) => ({ ...current, loading: false }));
          setError(describeError(listError, t));
        }
      }, [sessionId, papers.length, t]);

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
              callRemote(sessionId, "searchExternal", { query, limit: 10, sort: sortMode }, signal),
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
      }, [sessionId, query, mode, sortMode, t, runCancellable]);

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
          // Only PDFs. A directory pick can include anything; filtering here keeps
          // the error message about PDFs rather than about a stray .DS_Store.
          const picked = [...fileList].filter((file) => /\.pdf$/i.test(file.name ?? ""));
          if (picked.length === 0) {
            setError(t("noPdfFound"));
            return;
          }
          const maxFiles = importLimits.maxImportFiles;
          const maxBytes = importLimits.maxPdfBytes;
          // Over the limit is no longer a rejection. A folder of 41 papers imports
          // the first 32 and *says* how many were left, instead of refusing all 41
          // and leaving the user to work out which 32 to select by hand.
          const batch = picked.slice(0, maxFiles);
          const leftover = picked.length - batch.length;
          const files = [];
          const tooLarge = [];
          for (let index = 0; index < batch.length; index += 1) {
            const file = batch[index];
            // Check the size before reading: turning a 300MB file into a number
            // array blocks the tab long before the Host can reject it. Reported
            // per file rather than aborting the batch — one oversized scan must
            // not stop the other 31 from importing.
            if (file.size > maxBytes) {
              tooLarge.push(file.name);
              continue;
            }
            setNote(`${t("importing")} ${index + 1}/${batch.length}`);
            const buffer = await file.arrayBuffer();
            // The wire is JSON: send a number array, not a Uint8Array (which
            // would serialize as an object and fail the Host's byte parser).
            files.push({ name: file.name, data: Array.from(new Uint8Array(buffer)) });
          }
          if (files.length === 0) {
            setError(tooLarge.length > 0
              ? t("tooLarge", { limit: Math.round(maxBytes / 1024 / 1024) })
              : t("noPdfFound"));
            return;
          }
          const result = await runCancellable(t("busyStageImport"), (signal) =>
            callRemote(sessionId, "importPdf", { files }, signal),
          );
          const okCount = result.imported?.length ?? 0;
          const dupCount = result.duplicates?.length ?? 0;
          const failCount = result.failed?.length ?? 0;
          // Files the Host did not take because a caller sent more than the cap.
          const hostLeft = result.remaining ?? 0;
          const notHandled = leftover + hostLeft;
          await refresh();
          setNote([
            okCount > 0 ? `✓ ${okCount}` : "",
            dupCount > 0 ? `= ${dupCount}` : "",
            failCount > 0 ? `✕ ${failCount}` : "",
            // A cancelled import keeps what finished and says how much was dropped;
            // reporting only the successes would make a half-done import look done.
            result.aborted === true ? t("cancelSkipped", { n: result.skipped ?? 0 }) : "",
            // Say exactly what was skipped and why, with the number that applies.
            // "32 imported" out of 41 picked reads as "all done" otherwise.
            notHandled > 0 ? t("importLeftover", { n: notHandled, limit: maxFiles }) : "",
            tooLarge.length > 0
              ? t("importTooLargeSkipped", { n: tooLarge.length, limit: Math.round(maxBytes / 1024 / 1024) })
              : "",
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
      }, [sessionId, t, refresh, runCancellable, importLimits]);

      /**
       * Collect the files from a drop, walking directories.
       *
       * A drop carries DataTransferItem entries; anything dropped from the
       * filesystem is a file entry, and a directory has to be walked explicitly
       * because the browser does not flatten it. Dropping a Zotero `storage`
       * folder is the common case here — it is one directory containing hundreds
       * of subdirectories, which is exactly the shape a file picker handles badly.
       */
      const filesFromDataTransfer = useCallback(async (dataTransfer) => {
        const collected = [];
        // Safari exposes only `items` in some versions and only `files` in others;
        // `files` is already flattened, so use it when the entries are unusable.
        const items = dataTransfer?.items === undefined || dataTransfer.items === null
          ? []
          : [...dataTransfer.items];
        const entries = items
          .filter((item) => item.kind === "file")
          .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
          .filter((entry) => entry !== null);

        const readFile = (fileEntry) => new Promise((resolve) => {
          fileEntry.file((file) => resolve(file), () => resolve(null));
        });
        const readDirectory = (directoryEntry) => new Promise((resolve) => {
          const reader = directoryEntry.createReader();
          const all = [];
          // readEntries returns at most 100 entries per call, so it has to be
          // called until it yields nothing — a single call silently truncates a
          // large folder, which looks like "only part of the folder imported".
          // A reader that never returns an empty batch would spin forever. 200
          // batches is far past the 100-entry chunking a real browser does, so
          // hitting the cap means the reader is broken, not that the folder is big.
          const MAX_BATCHES = 200;
          let batches = 0;
          const step = () => reader.readEntries((entries) => {
            batches += 1;
            if (entries.length === 0 || batches > MAX_BATCHES) { resolve(all); return; }
            all.push(...entries);
            step();
          }, () => resolve(all));
          step();
        });
        // Depth cap. A folder tree is walked recursively, and a drop can name a
        // directory whose reader keeps producing entries (a symlink loop, or a
        // broken reader that never drains). Without a bound that is an unbounded
        // recursion inside a click handler, which shows up as "Maximum call stack
        // size exceeded" and loses the whole drop — including the files already
        // found.
        const MAX_DEPTH = 12;
        const walk = async (entry, depth = 0) => {
          if (depth > MAX_DEPTH) return;
          if (entry.isFile) {
            const file = await readFile(entry);
            if (file !== null) collected.push(file);
            return;
          }
          if (entry.isDirectory) {
            const children = await readDirectory(entry);
            for (const child of children) await walk(child, depth + 1);
          }
        };
        for (const entry of entries) await walk(entry);
        if (collected.length > 0) return collected;
        return [...(dataTransfer?.files ?? [])];
      }, []);

      const onPanelDragEnter = useCallback((event) => {
        // Only react to a file drag, not to text dragged out of the reader.
        if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragging(true);
      }, []);

      const onPanelDragOver = useCallback((event) => {
        if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
        // Without preventDefault the drop event never fires at all.
        event.preventDefault();
        if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
          event.dataTransfer.dropEffect = "copy";
        }
      }, []);

      const onPanelDragLeave = useCallback((event) => {
        if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
      }, []);

      const onPanelDrop = useCallback(async (event) => {
        if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragging(false);
        const dropped = await filesFromDataTransfer(event.dataTransfer);
        if (dropped.length === 0) return;
        await doImport(dropped);
      }, [doImport, filesFromDataTransfer]);

      const refreshWatch = useCallback(async () => {
        try {
          setWatchState(await callRemote(sessionId, "watchStatus"));
        } catch {
          // A status probe failing must not spam the panel with an error banner.
          setWatchState({ watching: false, dir: null });
        }
      }, [sessionId]);

      // Probe once on mount. The Host is the source of truth for whether a
      // watcher exists; the panel must show that, not a remembered preference.
      useEffect(() => { void refreshWatch(); }, [refreshWatch]);

      const toggleWatch = useCallback(async () => {
        setError(null);
        try {
          if (watchState?.watching === true) {
            setWatchState(await callRemote(sessionId, "watchStop"));
            setNote(t("watchOff"));
            return;
          }
          // A directory picker is the only way to name a folder from the browser.
          //
          // Cancelling has to resolve too. `oncancel` is not implemented in every
          // browser and never fires in some, so a promise that only resolves from
          // `onchange` leaves the panel waiting forever after the user closes the
          // dialog — no error, no state change, just a toggle that did nothing.
          const chosen = await new Promise((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            input.webkitdirectory = true;
            let settled = false;
            const finish = (value) => {
              if (settled) return;
              settled = true;
              resolve(value);
            };
            input.onchange = () => {
              const first = input.files?.[0];
              // webkitRelativePath carries the folder name; the Host needs an
              // absolute path, which only the desktop shell can supply. The RPC
              // takes the path the caller knows, so this is a fallback for when
              // the shell exposes one.
              finish(first?.path ?? null);
            };
            input.oncancel = () => finish(null);
            // The safety net: if neither event fires within a couple of minutes,
            // report the cancellation instead of holding the promise open.
            setTimeout(() => finish(null), 120_000);
            input.click();
          });
          if (chosen === null) {
            setError(t("watchNeedsPath"));
            return;
          }
          setWatchState(await callRemote(sessionId, "watchStart", { dir: chosen }));
          setNote(t("watchOn"));
        } catch (watchError) {
          setError(describeError(watchError, t));
        }
      }, [sessionId, t, watchState]);

      const refreshBackup = useCallback(async () => {
        if (!sessionId) return;
        try {
          setBackupStatus(await callRemote(sessionId, "backupStatus", {}));
        } catch (statusError) {
          // A missing backup view must not take the library down with it.
          setError(describeError(statusError, t));
        }
      }, [sessionId, t]);

      // Loaded once on mount so the panel can state the library's size before the
      // user commits to a backup. Declared here, after refreshBackup, because a
      // hook that references a `const` callback above its definition hits the
      // temporal dead zone and takes the whole pane down.
      useEffect(() => { void refreshBackup(); }, [refreshBackup]);

      const runBackup = useCallback(async () => {
        if (!sessionId) return;
        setBackupBusy("backup");
        setError(null);
        try {
          const result = await callRemote(sessionId, "backupLibrary", {});
          setBackupResult(result);
          await refreshBackup();
          // Report the numbers rather than "done": the user needs to know what
          // actually landed on disk, and an incomplete backup must not look fine.
          setNote(result.ok
            ? `${t("backupDone")} · ${formatBytes(result.report.sqliteBytes)} + ${result.report.pdfCount} PDF · ${formatDuration(result.report.durationMs)}`
            : `${t("backupIncomplete")} · ${result.problems.join("; ")}`);
          if (!result.ok) setError(result.problems.join("; "));
        } catch (backupError) {
          setError(describeError(backupError, t));
        } finally {
          setBackupBusy(null);
        }
      }, [sessionId, refreshBackup, t]);

      const runRestore = useCallback(async (directory) => {
        if (!sessionId || typeof directory !== "string" || directory === "") return;
        setBackupBusy("restore");
        setError(null);
        try {
          const result = await callRemote(sessionId, "restoreLibrary", {
            from: joinBackupPath(backupStatus?.backupsDir ?? "", directory),
            force: restoreForce,
          });
          setBackupResult(result);
          await refresh();
          await refreshBackup();
          setNote(`${t("restoreDone")} · ${result.filesCopied} PDF · ${result.pathsRewritten} ${t("pathsRewritten")}`);
          // A paper whose bytes did not come across is a real hole; say which.
          if ((result.pdfMissing ?? []).length > 0) {
            setError(`${t("restoreMissingPdf")}: ${result.pdfMissing.join(", ")}`);
          }
          setRestoreForce(false);
        } catch (restoreError) {
          // The guard's message names the target path; surface it as-is rather
          // than replacing it with a generic failure.
          setError(describeError(restoreError, t));
        } finally {
          setBackupBusy(null);
        }
      }, [sessionId, backupStatus, restoreForce, refresh, refreshBackup, t]);

      const runTopicRecommend = useCallback(async () => {
        const query = topicQuery.trim();
        if (!sessionId || query === "") return;
        setTopicBusy(true);
        setError(null);
        try {
          const result = await callRemote(sessionId, "topicRecommend", { query });
          setTopicResult(result);
          // A refusal is a real answer, not a failure: say why instead of leaving
          // the panel looking broken.
          if (result.refusal !== null && result.refusal !== undefined) {
            setNote(result.refusal.message);
          } else {
            setNote(`${t("topicFound")} · ${result.sample.dated} ${t("topicPapers")} · ${result.candidates.length} ${t("topicCandidates")}`);
          }
        } catch (topicError) {
          setError(describeError(topicError, t));
        } finally {
          setTopicBusy(false);
        }
      }, [sessionId, topicQuery, t]);

      const loadSegments = useCallback(async () => {
        if (!sessionId || translatePaperId === "") return;
        setTranslateBusy("segments");
        setError(null);
        try {
          const result = await callRemote(sessionId, "translateSegments", {
            paperId: translatePaperId,
            fromPage: translateFrom,
            toPage: translateTo,
            targetLang: translateTarget,
          });
          setTranslateResult(result);
          const stored = await callRemote(sessionId, "listTranslations", {
            paperId: translatePaperId, targetLang: translateTarget,
          });
          setTranslationRows(stored.translations ?? []);
          // Seed the editor with what is already stored, so re-opening a translated
          // page shows the existing text instead of looking untranslated.
          const seed = {};
          for (const row of stored.translations ?? []) seed[`${row.pageIndex}:${row.charStart}:${row.charEnd}`] = row.text;
          setTranslateDraft(seed);
          setNote(`${result.segments.length} ${t("segmentCount")}`);
        } catch (loadError) {
          setError(describeError(loadError, t));
        } finally {
          setTranslateBusy(null);
        }
      }, [sessionId, translatePaperId, translateFrom, translateTo, translateTarget, t]);

      const saveTranslations = useCallback(async () => {
        if (!sessionId || translatePaperId === "" || translateResult === null) return;
        setTranslateBusy("save");
        setError(null);
        try {
          const items = [];
          for (const segment of translateResult.segments) {
            const key = `${segment.pageIndex}:${segment.charStart}:${segment.charEnd}`;
            const text = (translateDraft[key] ?? "").trim();
            if (text === "") continue;
            items.push({
              pageIndex: segment.pageIndex,
              charStart: segment.charStart,
              charEnd: segment.charEnd,
              text,
            });
          }
          if (items.length === 0) {
            setError(t("noTranslationEntered"));
            return;
          }
          const saved = await callRemote(sessionId, "saveTranslation", {
            paperId: translatePaperId,
            targetLang: translateTarget,
            items,
          });
          const stored = await callRemote(sessionId, "listTranslations", {
            paperId: translatePaperId, targetLang: translateTarget,
          });
          setTranslationRows(stored.translations ?? []);
          await refresh();
          // Report rejections instead of only the success count: an item the Host
          // refused has silently disappeared otherwise.
          setNote(`${saved.saved} ${t("translationSaved")}`
            + (saved.rejected.length > 0 ? ` · ${saved.rejected.length} ${t("translationRejected")}` : ""));
          setError(saved.rejected.length > 0
            ? saved.rejected.map((row) => row.reason).join("; ")
            : null);
        } catch (saveError) {
          setError(describeError(saveError, t));
        } finally {
          setTranslateBusy(null);
        }
      }, [sessionId, translatePaperId, translateTarget, translateResult, translateDraft, refresh, t]);

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

      /**
       * Section skeleton — a structure proposal built from stored evidence.
       *
       * Deliberately a different button from 大纲 above. That one lists the material we
       * hold (evidence grouped by paper); this one proposes chapters and the evidence
       * each chapter should cite. Same word in Chinese, different output, so they sit in
       * separate toolbars with their own captions (D-016).
       */
      const buildSkeleton = useCallback(async () => {
        if (!sessionId) return;
        setBusy("skeleton");
        setError(null);
        try {
          setSkeleton(await callRemote(sessionId, "sectionSkeleton"));
        } catch (skeletonError) {
          setError(describeError(skeletonError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, t]);

      const sendSkeleton = useCallback(() => {
        if (!inputActions || !skeleton?.text) return;
        inputActions.insertText(skeleton.text);
      }, [inputActions, skeleton]);

      /**
       * Import a .bib / .ris file into the library.
       *
       * The file is read here, in the panel, and its text goes to the host — the host
       * has no filesystem access to the user's downloads folder, and asking for a path
       * would make the feature unusable on a machine where the panel and the CLI are
       * not the same place.
       */
      const importCitationFile = useCallback(async (file) => {
        if (!sessionId || file === null || file === undefined) return;
        setBusy("cite-import");
        setError(null);
        try {
          const text = await file.text();
          const result = await callRemote(sessionId, "importCitations", {
            fileName: String(file.name ?? ""),
            text,
          });
          setCiteImport(result);
          // An import changes the library, so the list and the counts have to be
          // refreshed; without this the new entries exist but the panel still shows the
          // old library and the import looks like it did nothing.
          await refresh();
        } catch (citeError) {
          // A cancelled import is not a failed import: showing "AbortError: The
          // operation was aborted" in a red banner reports the user's own cancel as a
          // defect. The import path above reaches the same conclusion and just refreshes,
          // letting the cancel banner stand.
          if (isAbortError(citeError)) {
            await refresh();
          } else {
            setError(describeError(citeError, t));
          }
        } finally {
          setBusy(null);
        }
      }, [sessionId, t, refresh]);

      /**
       * Check a passage against stored evidence.
       *
       * Not a similarity score and not an integrity check (D-015): the host returns the
       * rows that overlap and the disclaimer travels with them. Nothing is sent off the
       * machine, and no percentage exists to be misread.
       */
      const checkSimilarity = useCallback(async () => {
        if (!sessionId || similarText.trim() === "") return;
        setBusy("similar");
        setError(null);
        try {
          setSimilar(await callRemote(sessionId, "similarityNotice", { text: similarText }));
        } catch (similarError) {
          setError(describeError(similarError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, similarText, t]);

      // Only evidence whose offsets were located in the page text may be
      // exported: a citation that cannot point at the source is exactly what
      // the traceability claim forbids.
      //
      // These two are now *counts over the whole library*, taken from the paging
      // envelope. Deriving them from `evidence` would have been correct only while
      // the whole table was loaded; with paging it would report the size of the
      // current page as the size of the library.
      const anchoredTotal = evidencePaging.anchoredTotal;
      const allTotal = evidencePaging.allTotal;
      const excludedCount = allTotal - anchoredTotal;

      /**
       * Jump the OTHER panes to the same claim's evidence.
       *
       * The matrix already knows which evidence supports a claim in each paper. This
       * turns that into a reading action: with a selection made in pane A, each other
       * pane moves to its own matching passage. Without it, comparing means scrolling
       * each pane by hand and remembering the previous sentence — which is the whole
       * complaint PT-020 started from.
       */
      const jumpCompareToMatching = useCallback(() => {
        if (selection === null || comparePapers.length === 0) return;
        // Which rows in the loaded evidence share this claim's paper? Without a stored
        // claim there is nothing to match on, and guessing would jump to an unrelated
        // passage — so the honest answer is to say so rather than move the panes.
        const result = matchComparison(comparePapers, evidence, selection.text);
        if (result.moved === 0) {
          setNote(t("compareNoMatch"));
          return;
        }
        setComparePapers(result.panes);
        setNote(t("compareJumped", { count: String(result.moved) }));
      }, [selection, comparePapers, evidence, t]);

      const readerHighlight = useMemo(
        () => (reader?.quote ? { quote: reader.quote, pageIndex: reader.pageIndex } : null),
        [reader?.quote, reader?.pageIndex],
      );

      // Citations pass `anchoredOnly`, not an id list. The Host then filters in SQL
      // over the whole library. Passing the ids of the loaded page would have
      // produced a bibliography that silently omitted every unloaded row — the
      // failure mode is invisible, which is the worst kind for a citation tool.
      const renderCitations = useCallback(async () => {
        if (!sessionId) return;
        setBusy("citations");
        setError(null);
        try {
          const result = await callRemote(sessionId, "formatCitations", {
            style: citationStyle, locale: citationLocale, anchor: "anchored",
          });
          setCitation(result);
        } catch (citationError) {
          setError(describeError(citationError, t));
        } finally {
          setBusy(null);
        }
      }, [sessionId, citationStyle, citationLocale, t]);

      const doExport = useCallback(async () => {
        if (!sessionId) return;
        setBusy("export");
        setError(null);
        try {
          const result = await callRemote(sessionId, "exportReview", {
            style: citationStyle,
            locale: citationLocale,
            anchor: "anchored",
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
      }, [sessionId, citationStyle, citationLocale, t]);

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

      // Grouping only. The anchored/unanchored filter is applied by the Host now
      // (see `loadEvidence`), because it has to select across the whole library
      // rather than within the loaded page — re-applying it here would be
      // harmless but would imply to a later reader that the filter lives here.
      const evidenceGroups = useMemo(() => {
        const grouped = new Map();
        for (const row of evidence) {
          if (!grouped.has(row.paperId)) grouped.set(row.paperId, []);
          grouped.get(row.paperId).push(row);
        }
        return [...grouped.entries()];
      }, [evidence]);

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

      const renderWatchBar = () => h("div", { className: "pt-toolbar" },
        h(Badge, { tone: watchState?.watching === true ? "support" : undefined },
          watchState?.watching === true ? t("watchOn") : t("watchOff")),
        watchState?.watching === true && typeof watchState.dir === "string"
          ? h("span", { className: "pt-caption", style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            t("watchRoot", { dir: watchState.dir }))
          : h("span", { className: "pt-caption", style: { flex: 1, minWidth: 0 } }, t("watchHint")),
        h(Button, { variant: "ghost", onClick: toggleWatch, disabled: busy !== null },
          watchState?.watching === true ? t("watchOff") : t("watch")),
      );

      // --- backup -----------------------------------------------------------
      const backupPanel = () => {
        const measured = backupStatus?.measured;
        const backups = backupStatus?.backups ?? [];
        return h("div", { style: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { className: "pt-toolbar" },
            h("span", { className: "pt-h2" }, t("backupTitle")),
            h("div", { className: "pt-spacer" }),
            h(Button, { onClick: refreshBackup, disabled: backupBusy !== null }, t("refresh")),
            h(Button, { variant: "primary", onClick: runBackup, disabled: backupBusy !== null },
              backupBusy === "backup" ? t("backingUp") : t("backupNow")),
          ),
          // The sizes are shown before the copy, so "2 GB of PDFs" is a decision
          // the user makes with numbers rather than discovers afterwards.
          measured === undefined
            ? h("p", { className: "pt-caption", style: { margin: 0 } }, t("backupLoading"))
            : h("p", { className: "pt-caption", style: { margin: 0 } },
              t("backupSummary", {
                db: formatBytes(measured.dbBytes),
                files: formatBytes(measured.filesBytes),
                n: measured.pdfCount,
              })),
          backupStatus === null ? null : h("p", { className: "pt-caption", style: { margin: 0, wordBreak: "break-all" } },
            `${t("backupLivesAt")}: ${backupStatus.backupsDir}`),
          // Says out loud why the copy is not a file copy: this is the one
          // implementation detail a user is better off knowing.
          h("p", { className: "pt-caption", style: { margin: 0 } }, t("backupWalNote")),

          backups.length === 0
            ? h("p", { className: "pt-caption", style: { margin: 0 } }, t("backupNone"))
            : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              h("div", { className: "pt-toolbar" },
                h("span", { className: "pt-caption" }, t("backupExisting")),
                h("div", { className: "pt-spacer" }),
                h("label", { style: { display: "flex", gap: 4, alignItems: "center" } },
                  h("input", {
                    type: "checkbox", checked: restoreForce,
                    "aria-label": t("restoreForce"),
                    onChange: (event) => setRestoreForce(event.target.checked),
                  }),
                  h("span", { className: "pt-caption" }, t("restoreForce")),
                ),
              ),
              // Overwriting is refused by the Host unless force is ticked, and the
              // checkbox is right here so the refusal is understandable rather
              // than mysterious.
              restoreForce
                ? h(Banner, { tone: "error", title: t("restoreForceWarning") }, t("restoreForceDetail"))
                : null,
              backups.map((name) => h("div", { key: name, className: "pt-toolbar" },
                h("span", { className: "pt-meta", style: { wordBreak: "break-all" } }, name),
                h("div", { className: "pt-spacer" }),
                h(Button, {
                  onClick: () => runRestore(name),
                  disabled: backupBusy !== null,
                }, backupBusy === "restore" ? t("restoring") : t("restore")),
              )),
            ),

          backupResult === null ? null : h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
            h("div", { className: "pt-toolbar" },
              h("span", { className: "pt-caption" }, backupResult.ok === false ? t("backupIncomplete") : t("backupDone")),
            ),
            h("p", { className: "pt-caption pt-num", style: { margin: 0, wordBreak: "break-all" } }, backupResult.directory ?? backupResult.to ?? ""),
            backupResult.report === undefined ? null : h("p", { className: "pt-caption pt-num", style: { margin: 0 } },
              `sqlite ${formatBytes(backupResult.report.sqliteBytes)} · files ${formatBytes(backupResult.report.filesBytes)} · ${backupResult.report.pdfCount} PDF · ${formatDuration(backupResult.report.durationMs)}`),
            (backupResult.problems ?? []).length === 0 ? null : h("p", { className: "pt-caption", style: { margin: 0 } },
              backupResult.problems.join("; ")),
          ),
        );
      };

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
            // The sort control only appears for external search: the local library and
            // CNKI have one ranking each, so offering the choice there would be a control
            // that changes nothing.
            mode === "external"
              ? h("select", {
                className: "pt-input",
                value: sortMode,
                "aria-label": t("sortBy"),
                onChange: (event) => setSortMode(event.target.value),
              },
                h("option", { value: "relevance" }, t("sortRelevance")),
                h("option", { value: "citations" }, t("sortCitations")),
                h("option", { value: "year" }, t("sortYear")),
              )
              : null,
            h("div", { className: "pt-spacer" }),
            h(Button, { onClick: () => fileInputRef.current?.click(), disabled: busy !== null },
              busy === "import" ? t("importing") : t("import")),
            h(Button, { onClick: () => dirInputRef.current?.click(), disabled: busy !== null },
              t("importFolder")),
            h("input", {
              ref: fileInputRef, type: "file", accept: "application/pdf", multiple: true,
              "aria-label": t("import"),
              style: { display: "none" },
              onChange: (event) => doImport(event.target.files),
            }),
            h("input", {
              ref: dirInputRef, type: "file", accept: "application/pdf", multiple: true,
              // Non-standard but universally supported for directory picking, and
              // there is no standard alternative for it.
              webkitdirectory: "",
              directory: "",
              "aria-label": t("importFolder"),
              style: { display: "none" },
              onChange: (event) => doImport(event.target.files),
            }),
          ),
          renderWatchBar(),
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

        // --- compare panes -------------------------------------------------
        // Stacked, not side by side. The sidebar is 320-420 px wide; two columns would
        // give each page ~150 px, which is not a readable page but a thumbnail. A
        // vertical split keeps the full width and buys height instead, and this is the
        // documented tradeoff for PT-020 rather than an oversight.
        comparePapers.length > 0 ? h("div", {
          // Scrolled into view when the set changes. Found on the real GUI: after
          // clicking 加入比较 the panes were rendered ABOVE the viewport (the library
          // list was already scrolled down), so the click looked like it did nothing.
          ref: compareStackRef,
          // The container query hook: each pane adapts to the PANE height, not the
          // window, which is what makes three stacked panes still usable.
          className: "pt-pane-stack",
          "data-paper-tool": "compare",
          style: { padding: "8px 12px 0", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 8 },
        },
          h("div", { className: "pt-toolbar" },
            h("span", { className: "pt-caption" }, `${t("compareSet")} · ${comparePapers.length}/3`),
            h("div", { className: "pt-spacer" }),
            h(Button, { variant: "ghost", onClick: clearCompare }, t("compareClear")),
          ),
          ...comparePapers.map((paper) => h("div", {
            key: paper.paperId,
            className: `pt-pane${compareFocus === paper.paperId ? " pt-pane-focus" : ""}`,
            "data-compare-paper": paper.paperId,
            // The focused pane is marked with an attribute, not only a class: an
            // attribute survives class-list mechanics and is what the gate reads.
            "data-compare-focus": compareFocus === paper.paperId ? "true" : "false",
            // Focus follows interaction: clicking anywhere in a pane makes it the
            // target for the evidence panel and the toolbar.
            // Focus follows interaction. Only a click sets it: a focusin fires when the
            // close button inside a pane takes focus, which arrives as part of closing
            // that pane and would re-focus the paper being removed.
            onClick: () => setCompareFocus(paper.paperId),
          },
            h("div", { className: "pt-pane-head" },
              h("span", { className: "pt-pane-title" }, paper.title || paper.paperId),
              h("div", { className: "pt-spacer" }),
              compareFocus === paper.paperId
                ? h("span", { className: "pt-caption" }, t("compareFocused"))
                : null,
              // Only this pane's document is released: each PdfReader owns its own
              // loading task, so removing one pane cannot touch the others.
              h(Button, {
                variant: "ghost", icon: true, label: t("compareClose"),
                onClick: (event) => { event?.stopPropagation?.(); removeFromCompare(paper.paperId); },
              }, "×"),
            ),
            h("div", { style: { flex: "1 1 auto", minHeight: 0, display: "flex" } },
              h(PdfReader, {
                // Keyed by paper so going from 2 panes to 1 cannot shift a document
                // onto a different pane's canvas.
                key: paper.paperId,
                sessionId, paper, initialPage: paper.pageIndex, jumpToken: paper.jumpToken,
                // Each pane highlights its OWN quote. Using the focused pane's
                // highlight in every pane would paint the same passage onto papers
                // that never contained it.
                highlight: paper.quote ? { quote: paper.quote, pageIndex: paper.pageIndex } : null,
                annotations,
                t,
                onSelectionChange: (next) => { if (compareFocus === paper.paperId) setSelection(next); },
                onClose: () => removeFromCompare(paper.paperId),
              }),
            ),
          )),
        ) : reader ? h("div", { style: { padding: "8px 12px 0", flex: "1 1 auto", minHeight: 0, display: "flex" } },
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

        selection && (reader !== null || comparePapers.length > 0) ? h("div", { style: { padding: "8px 12px 0" } },
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
              // Only meaningful with more than one pane: with a single reader there is
              // nothing to jump the comparison to.
              comparePapers.length > 1
                ? h(Button, { onClick: jumpCompareToMatching, disabled: busy !== null, title: t("compareJumpHint") }, t("compareJump"))
                : null,
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
        reader !== null || comparePapers.length > 0 ? h("div", { style: { padding: "8px 12px 0", display: "flex", flexDirection: "column", gap: 6 } },
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
                    [
                      candidate.authors,
                      candidate.year,
                      candidate.venue,
                      candidate.source,
                      candidate.doi,
                      // A known zero and an unknown count must read differently. arXiv and
                      // PubMed publish no counts, so their candidates carry no number at all
                      // — writing "0 引用" would state a fact the source never provided, and
                      // would make a brand-new preprint look discredited.
                      candidate.citations === undefined || candidate.citations === null
                        ? null
                        : t("citationCount", { n: candidate.citations }),
                    ].filter(Boolean).join(" · ")),
                  candidate.abstract
                    ? h("span", { className: "pt-meta", style: { display: "block", marginTop: 4 } }, candidate.abstract.slice(0, 220))
                    : null,
                ),
              ),
            ))),
        ) : null,

        // Hidden for a single reader (which wants the whole column) but NOT for the
        // compare set: adding the second paper requires the list to be reachable.
        // Hiding it made the feature a one-shot.
        reader !== null ? null : h("div", { style: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 8 } },
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
          onCompare: addToCompare,
              onEdit: openEditor,
              onReextract: reextractOne,
              onEnrich: enrichOne,
              onReocr: reocrOne,
              onDelete: deletePaper,
            }))),
          // Only offered when there is more: a button that does nothing is worse
          // than no button. Hidden while a search is showing, because those results
          // are not paged at all.
          hits === null && paperPaging.hasMore
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              h(Button, {
                onClick: loadMorePapers,
                disabled: busy !== null || paperPaging.loading,
              }, paperPaging.loading
                ? t("loadingMore")
                : t("loadMore", { shown: papers.length, total: paperPaging.total })),
              h("span", { className: "pt-caption" },
                t("loadedOf", { shown: papers.length, total: paperPaging.total })))
            : null,
        ),
        // Backup lives at the bottom of the library view: it is about this library,
        // not about one paper, and it is maintenance rather than daily work.
        h("hr", { className: "pt-divider" }),
        backupPanel(),
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
            `${evidenceGroups.length} ${t("paperCount")} · ${evidence.length} ${t("evidenceCount")} · ${anchoredTotal} ${t("anchoredCount")}`),
          h("div", { className: "pt-spacer" }),
          // These switch the Host-side filter and reload page one. Filtering the
          // loaded rows in the browser would have answered a different question:
          // it would show the anchored rows *on this page*, while the label claims
          // to count all of them.
          h(Button, {
            variant: evidenceFilter === "all" ? "primary" : "ghost",
            onClick: () => setEvidenceFilter("all"),
          }, t("filterAll")),
          h(Button, {
            variant: evidenceFilter === "anchored" ? "primary" : "ghost",
            onClick: () => setEvidenceFilter("anchored"),
          }, `${t("filterAnchored")} ${anchoredTotal}`),
          excludedCount > 0 ? h(Button, {
            variant: evidenceFilter === "unanchored" ? "primary" : "ghost",
            onClick: () => setEvidenceFilter("unanchored"),
          }, `${t("filterUnanchored")} ${excludedCount}`) : null,
        );

        const evidenceBody = evidence.length === 0
          ? h(Empty, { title: t("evidenceEmpty"), hint: t("evidenceEmptyHint") })
          : h(React.Fragment, null, filterBar, evidenceList,
            evidencePaging.hasMore
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                h(Button, {
                  onClick: loadMoreEvidence,
                  disabled: busy !== null,
                }, busy === "evidenceMore"
                  ? t("loadingMore")
                  : t("evidenceLoadMore", { shown: evidence.length, total: evidencePaging.total })),
                // Say how much is not loaded. Silently showing one page of a larger
                // list reads as "this is everything", which for an evidence list
                // means a review that looks complete and is not.
                h("span", { className: "pt-caption" },
                  t("loadedOf", { shown: evidence.length, total: evidencePaging.total })))
              : null);

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
                    h(StanceBadge, { stance: row.stance, strength: row.strength, t }),
                  ),
                  h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
                    h("span", { className: "pt-caption pt-num" },
                      `+${row.supportCount ?? 0} · −${row.conflictCount ?? 0} · ?${row.notFoundCount ?? 0}`),
                    h("div", { className: "pt-spacer" }),
                    target !== undefined ? h(Button, {
                      variant: "ghost", icon: true, label: t("jumpToPage"),
                      onClick: () => jumpToEvidence(target),
                    }, "↗") : null,
                    // The real motivation for PT-020: the matrix already says "3 papers
                    // support this, 1 conflicts", but to read what those 4 actually said
                    // the user had to open them one at a time and remember the previous
                    // sentence. This opens the row's paper beside whatever is currently
                    // open, landing on the evidence the matrix is pointing at.
                    h(Button, {
                      variant: "ghost",
                      label: t("compareFromMatrix"),
                      onClick: () => {
                        const landing = target ?? null;
                        // Current context first: whichever paper is open in the single
                        // reader, or the focused pane. Otherwise the click would produce
                        // a lone pane and there would be nothing to compare against.
                        const context = reader !== null
                          ? reader
                          : (comparePapers.find((paper) => paper.paperId === compareFocus) ?? null);
                        // A comparison needs two DIFFERENT papers. When the row's paper is
                        // already the one being read, bring in another paper from the same
                        // matrix instead of adding a duplicate — otherwise the click lands
                        // on a single pane and looks like it did nothing.
                        if (context === null || context.paperId === row.paperId) {
                          const sibling = (matrix?.rows ?? []).find((candidate) => candidate.paperId !== row.paperId);
                          if (sibling === undefined) return;
                          addToCompare({
                            paperId: sibling.paperId,
                            title: sibling.title,
                            pageIndex: 0,
                            quote: null,
                            paper: { paperId: sibling.paperId, title: sibling.title },
                          });
                        } else {
                          addToCompare(context);
                        }
                        addToCompare({
                          paperId: row.paperId,
                          title: row.title,
                          pageIndex: landing === null ? 0 : landing.pageIndex,
                          quote: landing === null ? null : landing.quote,
                          paper: { paperId: row.paperId, title: row.title },
                        });
                      },
                    }, t("compareFromMatrix")),               ),
                  // The reasons behind this row's verdict. Without them the matrix
                  // is a set of numbers the reviewer has to take on faith; with
                  // them it is a list of passages to go read, which is what a
                  // stance judgement is actually for.
                  (row.judgements ?? []).length === 0 ? null : h("ul", {
                    className: "pt-caption",
                    style: { margin: "4px 0 0", paddingLeft: 16 },
                  }, row.judgements.slice(0, 3).map((judgement) => h("li",
                    { key: judgement.evidenceId, style: { marginTop: 2 } },
                    h("span", { className: "pt-caption" },
                      `${judgement.stance === "conflict" ? "✕" : judgement.stance === "support" ? "✓" : "?"} ${judgement.rationale}`)))),
                );
              })),
          ) : null,
        ),
      );
      };

      // --- translation view ------------------------------------------------
      // Two columns, paired by anchor rather than by position. Pairing by position
      // would look correct until one paragraph is skipped and then silently shift
      // every translation below it onto the wrong original.
      const segmentKey = (row) => `${row.pageIndex}:${row.charStart}:${row.charEnd}`;
      const renderTranslate = () => {
        const paperChoices = papers.map((paper) => h("option", { key: paper.paperId, value: paper.paperId },
          paper.title || paper.paperId));
        const segments = translateResult?.segments ?? [];
        const stored = new Map(translationRows.map((row) => [segmentKey(row), row]));
        const ocrPages = new Set(translateResult?.ocrPages ?? []);

        const rows = segments.map((segment) => {
          const key = segmentKey(segment);
          const saved = stored.get(key);
          const draftValue = translateDraft[key] ?? saved?.text ?? "";
          return h("tr", { key },
            h("td", { className: "pt-tr-src" },
              h("div", { className: "pt-tr-meta" }, `p${segment.pageIndex + 1} · ${segment.charStart}-${segment.charEnd}`),
              h("div", null, segment.text),
              // OCR provenance is shown per segment, next to the original it applies
              // to. A translation of recognized text inherits the recognition errors,
              // and the reader has to be able to see that while reading the
              // translation rather than being told once at the top.
              ocrPages.has(segment.pageIndex)
                ? h("div", { className: "pt-tr-caveat" }, t("translateOcrCaveat"))
                : null,
            ),
            h("td", { className: "pt-tr-dst" },
              h("textarea", {
                className: "pt-tr-input",
                value: draftValue,
                "aria-label": t("translateSegmentAria", { page: segment.pageIndex + 1, start: segment.charStart }),
                onChange: (event) => setTranslateDraft((current) => ({ ...current, [key]: event.target.value })),
              }),
            ),
          );
        });

        const untranslated = translateResult === null
          ? 0
          : segments.filter((segment) => !stored.has(segmentKey(segment))).length;

        return h("div", { style: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 10 } },
          h("p", { className: "pt-caption", style: { margin: 0 } }, t("translateIntro")),
          h("div", { className: "pt-toolbar" },
            h("select", {
              className: "pt-select pt-toolbar-grow",
              value: translatePaperId,
              "aria-label": t("translatePaper"),
              onChange: (event) => { setTranslatePaperId(event.target.value); setTranslateResult(null); setTranslationRows([]); setTranslateDraft({}); },
            },
              h("option", { value: "" }, t("translatePickPaper")),
              paperChoices,
            ),
          ),
          h("div", { className: "pt-toolbar" },
            h("label", { style: { display: "flex", gap: 4, alignItems: "center" } },
              h("span", { className: "pt-caption" }, t("translateFrom")),
              h("input", {
                className: "pt-input pt-num", type: "number", min: 1, value: translateFrom + 1,
                style: { width: 64 }, "aria-label": t("translateFrom"),
                onChange: (event) => setTranslateFrom(Math.max(0, Number(event.target.value) - 1)),
              }),
            ),
            h("label", { style: { display: "flex", gap: 4, alignItems: "center" } },
              h("span", { className: "pt-caption" }, t("translateTo")),
              h("input", {
                className: "pt-input pt-num", type: "number", min: 1, value: translateTo + 1,
                style: { width: 64 }, "aria-label": t("translateTo"),
                onChange: (event) => setTranslateTo(Math.max(0, Number(event.target.value) - 1)),
              }),
            ),
            h("label", { style: { display: "flex", gap: 4, alignItems: "center" } },
              h("span", { className: "pt-caption" }, t("translateInto")),
              h("select", {
                className: "pt-select", style: { width: "auto" }, value: translateTarget,
                "aria-label": t("translateInto"),
                onChange: (event) => setTranslateTarget(event.target.value),
              },
                h("option", { value: "zh" }, "中文"),
                h("option", { value: "en" }, "English"),
              ),
            ),
            h("div", { className: "pt-spacer" }),
            h(Button, { onClick: loadSegments, disabled: translateBusy !== null || translatePaperId === "" },
              translateBusy === "segments" ? t("loadingSegments") : t("loadSegments")),
            h(Button, {
              variant: "primary", onClick: saveTranslations,
              disabled: translateBusy !== null || segments.length === 0,
            }, translateBusy === "save" ? t("saving") : t("saveTranslation")),
          ),
          translateResult === null
            ? h(Empty, { title: t("translateEmpty") })
            : h("div", null,
              h("div", { className: "pt-toolbar" },
                h("span", { className: "pt-caption pt-num" },
                  `${segments.length} ${t("segmentCount")} · ${stored.size} ${t("translatedCount")} · ${untranslated} ${t("untranslatedCount")}`),
                h("div", { className: "pt-spacer" }),
                h(Badge, { tone: untranslated === 0 ? "support" : undefined },
                  untranslated === 0 ? t("alignedAll") : t("alignedPartly", { n: untranslated })),
              ),
              ocrPages.size > 0
                ? h("p", { className: "pt-caption", style: { margin: "0 0 6px" } },
                  t("translateOcrNote", { n: ocrPages.size }))
                : null,
              h("div", { className: "pt-table-wrap" },
                h("table", { className: "pt-tr-table" },
                  h("thead", null,
                    h("tr", null,
                      h("th", null, t("translateSourceCol")),
                      h("th", null, t("translateTargetCol")),
                    ),
                  ),
                  h("tbody", null, rows),
                ),
              ),
            ),
        );
      };

      const renderTopics = () => {
        const result = topicResult;
        const trend = result?.trend;
        // The strongest year in the window, used only to scale the bars: a chart
        // that does not show its own scale is a decoration.
        const peak = trend === undefined || trend.years.length === 0
          ? 0
          : Math.max(...trend.years.map((row) => row.count), 1);
        return h("div", { style: { padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 10 } },
          h("div", { className: "pt-toolbar" },
            h("input", {
              className: "pt-input pt-toolbar-grow",
              value: topicQuery,
              placeholder: t("topicPlaceholder"),
              "aria-label": t("topicPlaceholder"),
              onChange: (event) => setTopicQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") void runTopicRecommend(); },
            }),
            h(Button, { variant: "primary", onClick: runTopicRecommend, disabled: topicBusy || topicQuery.trim() === "" },
              topicBusy ? t("topicWorking") : t("topicRecommend")),
          ),
          // The disclaimer sits above the result, not below it: this is the one
          // screen where a user is most likely to read counted material as a
          // literature conclusion.
          h("p", { className: "pt-caption", style: { margin: 0 } }, t("topicDisclaimer")),

          result === null
            ? h("p", { className: "pt-caption", style: { margin: 0 } }, t("topicIntro"))
            : h(React.Fragment, null,
              // Provenance first: the sample size decides whether anything below is
              // worth reading, so it cannot be buried under the results.
              h("div", { className: "pt-toolbar" },
                h("span", { className: "pt-caption" },
                  `${t("topicSample")}: ${result.sample.dated} ${t("topicPapers")}`),
                result.sample.undated > 0
                  ? h("span", { className: "pt-caption" }, `· ${result.sample.undated} ${t("topicUndated")}`)
                  : null,
                h("div", { className: "pt-spacer" }),
                result.refusal === null
                  ? h("span", { className: "pt-caption" }, `· ${t("topicMinSample")} ${result.sample.minSample}`)
                  : null,
              ),

              // Refusal is rendered prominently and replaces the results, rather than
              // appearing as a footnote under an empty chart.
              result.refusal === null
                ? null
                : h(Banner, { tone: "warning", title: t("topicInsufficient") }, result.refusal.message),

              result.refusal === null && trend !== undefined && trend.years.length > 0
                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
                  h("div", { className: "pt-toolbar" },
                    h("span", { className: "pt-h2" }, t("topicTrend")),
                    h("div", { className: "pt-spacer" }),
                    h("span", { className: "pt-caption" },
                      `${trend.window.from}–${trend.window.to} · ${t("topicDirection")}: ${t(`topicDir_${trend.direction}`)}`),
                  ),
                  // One row per year with a bar proportional to the peak. Rendered as
                  // text-width bars so it works at any panel width without a chart lib.
                  ...trend.years.map((row) => h("div", { key: row.year, className: "pt-toolbar" },
                    h("span", { className: "pt-caption pt-num", style: { width: 44 } }, String(row.year)),
                    h("span", {
                      className: "pt-tr-bar",
                      style: { width: `${Math.max(2, Math.round((row.count / peak) * 100))}%` },
                      "aria-label": `${row.year}: ${row.count}`,
                    }),
                    h("span", { className: "pt-caption pt-num" }, String(row.count)),
                  )),
                )
                : null,

              // Counts this plugin computed, stated as counts. Nothing here infers a
              // conclusion from them.
              result.gaps.length === 0
                ? null
                : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h("span", { className: "pt-h2" }, t("topicGaps")),
                  ...result.gaps.slice(0, 6).map((gap) => h("div", { key: gap.terms.join("+"), className: "pt-topic-gap" },
                    h("div", { className: "pt-toolbar" },
                      h("span", { className: "pt-meta" }, gap.terms.join(" × ")),
                      h("div", { className: "pt-spacer" }),
                      h("span", { className: "pt-caption" },
                        `${t("topicCoOccur")} ${gap.coOccurrences} · ${t("topicIndependent")} ${gap.independentA}/${gap.independentB}`),
                    ),
                    // The supporting paper ids, so the claim is checkable.
                    h("span", { className: "pt-caption pt-num" }, gap.paperIds.slice(0, 6).join(", ")),
                  )),
                ),

              result.candidates.length === 0
                ? null
                : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                  h("span", { className: "pt-h2" }, t("topicCandidates")),
                  ...result.candidates.map((candidate, index) => h("div", { key: index, className: "pt-topic-card" },
                    h("div", { className: "pt-meta", style: { fontWeight: 600 } }, candidate.title),
                    h("p", { className: "pt-caption", style: { margin: "2px 0" } },
                      `${t("topicQuestion")}: ${candidate.researchQuestion}`),
                    h("p", { className: "pt-caption", style: { margin: 0 } },
                      `${t("topicFeasibility")}: ${candidate.feasibility.note}`),
                    h("p", { className: "pt-caption", style: { margin: 0 } },
                      `${t("topicInnovation")}: ${candidate.innovation.note}`),
                    // Provenance is shown, not hidden: every row names what produced it.
                    h("p", { className: "pt-caption pt-num", style: { margin: 0, opacity: 0.75 } },
                      `${candidate.provenance.kind} · ${(candidate.provenance.paperIds ?? []).length} ${t("topicPapers")}`),
                  )),
                ),

              result.representatives.length === 0
                ? null
                : h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                  h("span", { className: "pt-h2" }, t("topicRepresentatives")),
                  ...result.representatives.map((paper, index) => h("div", { key: index, className: "pt-toolbar" },
                    h("span", { className: "pt-meta" }, paper.title),
                    h("div", { className: "pt-spacer" }),
                    h("span", { className: "pt-caption pt-num" },
                      paper.citations === null ? paper.year : `${paper.year} · ${paper.citations}`),
                  )),
                ),

              // Source health last: a source that failed changes how much of the
              // sample above is missing, and that is worth knowing.
              result.provenance.failures.length === 0
                ? null
                : h("p", { className: "pt-caption", style: { margin: 0 } },
                  `${t("topicSourceFailures")}: ${result.provenance.failures.map((row) => `${row.source} (${row.reason})`).join("; ")}`),
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

        // --- 章节骨架 ---------------------------------------------------
        // Sits directly under the evidence outline on purpose: they answer two halves of
        // the same question, and putting them side by side is what makes the difference
        // visible instead of something the reader has to take on faith (D-016).
        h("div", { className: "pt-toolbar" },
          h("span", { className: "pt-h2" }, t("skeleton")),
          h("div", { className: "pt-spacer" }),
          h(Button, { onClick: buildSkeleton, disabled: busy !== null }, t("buildSkeleton")),
          // Only offered when there are sections to send. An empty result is a refusal
          // ("no evidence to build from"); sending that sentence to the conversation
          // would just push a non-answer into the chat.
          skeleton !== null && skeleton.sections.length > 0
            ? h(Button, { onClick: sendSkeleton, disabled: !inputActions, variant: "primary" }, t("sendToChat"))
            : null,
        ),
        h("p", { className: "pt-caption", style: { margin: 0 } }, t("skeletonHint")),
        skeleton
          ? h("div", { className: "pt-col", style: { gap: 6 } },
            // Empty and non-empty are different answers, so they render different
            // things. The empty case is a single banner: the host's note already says
            // why nothing came back, and printing it twice made it read like two
            // separate problems.
            skeleton.sections.length === 0
              ? h(Banner, { tone: "info" }, skeleton.note)
              : [
                // A Fragment with a key, not a bare array: React cannot key the array
                // elements themselves, and the raw array form warned about it.
                h(React.Fragment, { key: "sections" },
                  ...skeleton.sections.map((section, index) => h("div", {
                  key: section.id,
                  className: "pt-card",
                  "data-section": section.id,
                  style: { padding: "6px 8px" },
                },
                  h("div", { className: "pt-toolbar" },
                    h("span", { className: "pt-meta" }, `${index + 1}. ${section.title}`),
                    h("div", { className: "pt-spacer" }),
                    h("span", { className: "pt-caption pt-num" }, `${section.evidenceIds.length} 条 · ${section.paperIds.length} 篇`),
                  ),
                  h("p", { className: "pt-caption", style: { margin: 0 } }, section.purpose),
                  // The bound ids, labelled as such. This used to reuse the overlap
                  // panel's "命中条目" caption, which said the ids were overlap hits —
                  // wrong label on real data.
                  // Readable locators, not raw ids. `f71258aa` appears nowhere else in
                  // the UI, so printing the id prefix told the writer nothing they could
                  // act on; the paper title and page are what they need to find it.
                  h("div", { className: "pt-col", style: { gap: 2 } },
                    h("p", { className: "pt-caption", style: { margin: 0 } }, t("skeletonBinds")),
                    ...(section.citations ?? []).map((cite) => h("p", {
                      key: cite.evidenceId,
                      className: "pt-caption",
                      style: { margin: 0 },
                      title: cite.quote === "" ? undefined : cite.quote,
                    }, `· ${cite.paperTitle === "" ? t("unknownPaper") : cite.paperTitle}${cite.pageIndex >= 0 ? ` p.${cite.pageIndex + 1}` : ""}`)),
                  ),
                  )),
                ),
                h("p", { key: "note", className: "pt-caption", style: { margin: 0 } }, skeleton.note),
              ],
          )
          : null,

        h("hr", { className: "pt-divider" }),

        // --- 导入 .bib / .ris -------------------------------------------
        h("div", { className: "pt-toolbar" },
          h("span", { className: "pt-h2" }, t("citeImport")),
          h("div", { className: "pt-spacer" }),
          h(Button, { onClick: () => citeImportRef.current?.click(), disabled: busy !== null }, t("citeImportPick")),
          h("input", {
            ref: citeImportRef,
            type: "file",
            // Both extensions: the picker filters by them, and the host detects the
            // format from the name first and the content second.
            accept: ".bib,.bibtex,.ris",
            "aria-label": t("citeImportPick"),
            style: { display: "none" },
            onChange: (event) => {
              const file = event.target.files?.[0] ?? null;
              // Clear the input so choosing the same file twice still fires onChange.
              event.target.value = "";
              if (file !== null) void importCitationFile(file);
            },
          }),
        ),
        h("p", { className: "pt-caption", style: { margin: 0 } }, t("citeImportHint")),
        citeImport
          ? h("div", { className: "pt-col", style: { gap: 4 } },
            h("p", { className: "pt-caption", style: { margin: 0 } }, citeImport.text),
            citeImport.imported?.length > 0
              ? h("p", { className: "pt-caption", style: { margin: 0 } },
                citeImport.imported.map((row) => row.title).join(" · "))
              : h("p", { className: "pt-caption", style: { margin: 0 } }, t("citeImportEmpty")),
          )
          : null,

        h("hr", { className: "pt-divider" }),

        // --- 库内重叠提示 -----------------------------------------------
        // Named 重叠 (overlap) rather than 查重 (integrity check) throughout, and the
        // caption says what it is not. Both choices are load-bearing (D-015): the label
        // is what stops the next person from growing it into a similarity score.
        h("div", { className: "pt-toolbar" },
          h("span", { className: "pt-h2" }, t("similar")),
          h("div", { className: "pt-spacer" }),
          h(Button, {
            onClick: checkSimilarity,
            // Disabled when there is nothing to compare against, not only when the box
            // is empty: a click with an empty library used to come back reading like a
            // clean result. Better to not offer the action.
            disabled: busy !== null || similarText.trim() === "" || (evidencePaging.allTotal ?? 0) === 0,
            title: (evidencePaging.allTotal ?? 0) === 0 ? t("similarNoEvidence") : undefined,
          }, busy === "similar" ? t("searching") : t("similarCheck")),
        ),
        h("p", { className: "pt-caption", style: { margin: 0 } }, t("similarHint")),
        // Said before the click, not after it: with no evidence stored the action has
        // no input, and the caption is where that can be stated without a round trip.
        (evidencePaging.allTotal ?? 0) === 0
          ? h("p", { className: "pt-caption", style: { margin: 0 } }, t("similarNoEvidence"))
          : null,
        h("textarea", {
          className: "pt-input",
          "aria-label": t("similar"),
          placeholder: t("similarPlaceholder"),
          rows: 4,
          value: similarText,
          onChange: (event) => setSimilarText(event.target.value),
          style: { resize: "vertical", fontFamily: "inherit" },
        }),
        similar
          ? h("div", { className: "pt-col", style: { gap: 4 } },
            h("p", { className: "pt-caption", style: { margin: 0 } }, similar.note),
            similar.hits.length === 0
              ? null
              : similar.hits.map((hit) => h("div", {
                key: hit.evidenceId,
                className: "pt-card",
                "data-similar-hit": hit.evidenceId,
                style: { padding: "6px 8px" },
              },
                h("div", { className: "pt-toolbar" },
                  h("span", { className: "pt-meta" }, hit.paperTitle || hit.paperId),
                  h("div", { className: "pt-spacer" }),
                  h("span", { className: "pt-caption pt-num" }, `p.${hit.pageIndex + 1} · ${hit.overlapChars} 字`),
                ),
                h("p", { className: "pt-caption", style: { margin: 0 } }, hit.quote),
              )),
            // The disclaimer is rendered from the response's own field, not from a
            // hardcoded string in the client: if the host's wording changes, the panel
            // cannot drift away from it.
            h("p", { className: "pt-caption", style: { margin: 0 } }, similar.disclaimer ?? t("similarDisclosure")),
          )
          : null,

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
          h(Button, { variant: "primary", onClick: renderCitations, disabled: busy !== null || anchoredTotal === 0 },
            busy === "citations" ? t("searching") : t("generateCitations")),
        ),
        h("p", { className: "pt-caption", style: { margin: 0 } },
          // Counted over the whole library, not the loaded page: this caption sits
          // next to the citation button and describes what that button will cite.
          anchoredTotal === 0
            ? t("noEvidence")
            : `${anchoredTotal} ${t("evidenceCount")} · ${t("anchoredCount")}${excludedCount > 0 ? ` · ${t("unlocatedExcluded", { n: excludedCount })}` : ""}`),

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
            disabled: busy !== null || anchoredTotal === 0,
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
        ["translate", t("translateTab"), translationRows.length > 0 ? translationRows.length : null],
        ["topics", t("topicsTab"), topicResult === null ? null : topicResult.candidates.length],
        ["review", t("reviewTab"), null],
      ];
      return h("div", {
        className: "pt-root",
        "data-paper-tool": view,
        // Dropping PDFs anywhere on the panel imports them. Bound on the root so
        // the whole surface is a target, not just a small drop zone.
        onDragEnter: onPanelDragEnter,
        onDragOver: onPanelDragOver,
        onDragLeave: onPanelDragLeave,
        onDrop: onPanelDrop,
      },
        dragging
          ? h("div", { className: "pt-drop-veil" }, h("span", { className: "pt-drop-veil-label" }, t("dropToImport")))
          : null,
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
            view === "library" ? renderLibrary() : view === "evidence" ? renderEvidence() : view === "translate" ? renderTranslate() : view === "topics" ? renderTopics() : renderReview()),
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
      __test: { Body, PdfReader, PaperCard, MetadataEditor, EvidenceRow, StanceBadge, ViewBoundary, snippetNodes, CSS, DICTS, matchComparison, readStoredCompare, writeStoredCompare, fitScale },
    };
  },
});

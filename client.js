// Browser client for @local/paper-tool.
//
// One right-sidebar tab with three views: library, evidence, review. The tab
// never invents citations: it shows stored metadata, page-anchored evidence and
// CSL-rendered bibliographies, and hands prose writing to the chat model.
window.__ModuleLoader__.load({
  id: "@local/paper-tool",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useCallback, useEffect, useRef, useMemo } = React;

    const NS = "paperTool";
    const TAB_ID = "@local/paper-tool/library";
    const KIND = "paper-tool";

    const DICTS = {
      zh: {
        title: "论文",
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
        noResults: "没有匹配结果。",
        fulltext: "有全文",
        metaOnly: "仅书目",
        noPdf: "无 PDF",
        page: "第",
        pages: "页",
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
        noSelection: "先在 PDF 里选中文字",
        askHint: "提问会带上论文、页码与引文",
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
        evidenceAnchored: "已定位",
        evidenceUnanchored: "页码已记录，原文偏移未定位",
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
        cnkiConnecting: "正在打开浏览器…",
        cnkiSearch: "检索知网",
        addSelected: "加入文献库",
        added: "已加入",
        downloading: "下载中…",
        noCandidates: "没有结果。",
        sourcesFailed: "部分来源失败",
        metadataOnlyNote: "外部条目只有书目，不是全文。",
        reload: "刷新",
        statusError: "连接失败",
        retry: "重试",
        confirm: "确认",
        back: "返回",
        total: "共",
        noEvidence: "还没有证据，无法生成引用。",
        selectEvidence: "选择证据后生成引用；默认使用全部证据。",
        evidenceCount: "条证据",
        paperCount: "篇论文",
        generatedAt: "生成时间",
      },
      en: {
        title: "Papers",
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
        noResults: "No matches.",
        fulltext: "full text",
        metaOnly: "metadata only",
        noPdf: "no PDF",
        page: "Page",
        pages: "pages",
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
        noSelection: "Select text in the PDF first",
        askHint: "The question carries paper, page and quote",
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
        evidenceAnchored: "anchored",
        evidenceUnanchored: "page recorded, offset not located",
        collect: "Collect by topic",
        collectPlaceholder: "Topic, e.g. carbon emissions determinants",
        collectHint: "Find relevant sentences in indexed pages and store them",
        matrix: "Evidence matrix",
        claimPlaceholder: "Enter a claim to check support/conflict per paper",
        checkStance: "Check stance",
        coverage: "Coverage only",
        support: "support",
        conflict: "conflict",
        notFound: "not found",
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
        cnkiConnecting: "Opening browser…",
        cnkiSearch: "Search CNKI",
        addSelected: "Add to library",
        added: "Added",
        downloading: "Downloading…",
        noCandidates: "No results.",
        sourcesFailed: "Some sources failed",
        metadataOnlyNote: "External entries are metadata only, not full text.",
        reload: "Refresh",
        statusError: "Connection failed",
        retry: "Retry",
        confirm: "Confirm",
        back: "Back",
        total: "total",
        noEvidence: "No evidence yet; cannot render citations.",
        selectEvidence: "Citations use all evidence by default.",
        evidenceCount: "evidence",
        paperCount: "papers",
        generatedAt: "Generated",
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
      "formatCitations", "exportReview", "searchExternal", "addCandidates",
      "cnkiSearch", "cnkiDownload",
    ]);

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
        const error = new Error(envelope.error?.message ?? "rpc failed");
        error.code = envelope.error?.code;
        throw error;
      }
      return envelope?.ok === true ? envelope.value : envelope;
    }

    const styles = {
      root: {
        display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px",
        minHeight: "100%", font: "inherit", color: "inherit", boxSizing: "border-box",
      },
      header: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" },
      row: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
      input: {
        flex: "1 1 130px", minWidth: 0, padding: "5px 8px", fontSize: "inherit",
        color: "inherit", background: "transparent", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #8884)",
      },
      textarea: {
        width: "100%", boxSizing: "border-box", minHeight: 52, resize: "vertical",
        padding: "5px 8px", fontSize: "inherit", color: "inherit",
        background: "transparent", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #8884)",
      },
      button: {
        padding: "4px 9px", fontSize: "inherit", color: "inherit", cursor: "pointer",
        background: "transparent", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #8884)",
      },
      primary: {
        borderColor: "var(--dsw-alias-accent, #3b82f6)",
        background: "var(--dsw-alias-accent-soft, #3b82f61a)",
      },
      danger: { borderColor: "var(--dsw-alias-danger, #d33)", color: "var(--dsw-alias-danger, #d33)" },
      muted: { fontSize: "0.82em", opacity: 0.72, margin: 0 },
      list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
      card: {
        padding: "7px 9px", borderRadius: 8,
        border: "1px solid var(--dsw-alias-border, #8884)",
      },
      cardButton: {
        padding: "7px 9px", borderRadius: 8, cursor: "pointer", textAlign: "left",
        color: "inherit", background: "transparent", width: "100%",
        border: "1px solid var(--dsw-alias-border, #8884)",
      },
      snippet: { fontSize: "0.83em", opacity: 0.8, margin: "3px 0 0", wordBreak: "break-word" },
      badge: {
        fontSize: "0.72em", padding: "1px 6px", borderRadius: 999, whiteSpace: "nowrap",
        border: "1px solid var(--dsw-alias-border, #8884)", opacity: 0.85,
      },
      badgeSupport: { borderColor: "#2e9d63", color: "#2e9d63" },
      badgeConflict: { borderColor: "#d97706", color: "#d97706" },
      badgeMissing: { opacity: 0.6 },
      nav: { display: "flex", gap: 4, borderBottom: "1px solid var(--dsw-alias-border, #8884)", paddingBottom: 6 },
      navItem: {
        padding: "3px 8px", fontSize: "0.9em", cursor: "pointer", borderRadius: 6,
        color: "inherit", background: "transparent", border: "1px solid transparent",
      },
      navActive: {
        borderColor: "var(--dsw-alias-border, #8884)",
        background: "var(--dsw-alias-accent-soft, #3b82f61a)",
      },
      reader: {
        display: "flex", flexDirection: "column", gap: 8,
        borderTop: "1px solid var(--dsw-alias-border, #8884)", paddingTop: 8, marginTop: 2,
      },
      canvasWrap: {
        overflow: "auto", maxHeight: "56vh", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #8884)",
        background: "var(--dsw-alias-bg, #fff)",
        padding: 6,
      },
      pageWrap: { position: "relative", margin: "0 auto" },
      askBox: { display: "flex", flexDirection: "column", gap: 6 },
      error: { fontSize: "0.85em", color: "var(--dsw-alias-danger, #d33)", margin: 0, whiteSpace: "pre-wrap" },
      note: { fontSize: "0.82em", opacity: 0.8, margin: 0 },
      pre: {
        whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text",
        fontSize: "0.85em", lineHeight: 1.5, margin: 0, maxHeight: "28vh", overflow: "auto",
        padding: "6px 8px", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #8884)",
        background: "var(--dsw-alias-bg, #fff)",
      },
      group: { display: "flex", flexDirection: "column", gap: 4 },
      evidenceRow: {
        display: "flex", gap: 6, alignItems: "flex-start", padding: "5px 7px",
        borderRadius: 6, border: "1px solid var(--dsw-alias-border, #8884)",
      },
      quote: { flex: 1, margin: 0, fontSize: "0.84em", wordBreak: "break-word" },
      field: { display: "flex", flexDirection: "column", gap: 2, fontSize: "0.85em" },
      spacer: { flex: 1 },
      selectionBar: {
        display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: 6,
        background: "var(--dsw-alias-accent-soft, #3b82f61a)",
        border: "1px solid var(--dsw-alias-accent, #3b82f6)",
      },
    };

    let cssInjected = false;
    function ensureCss() {
      if (cssInjected || typeof document === "undefined") return;
      const style = document.createElement("style");
      style.dataset.paperToolStyle = "1";
      style.textContent = `
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
        .pt-textLayer ::selection { background: rgba(59, 130, 246, 0.35); }
        .pt-textLayer .pt-hit { background: rgba(250, 204, 21, 0.45); }
      `;
      document.head.appendChild(style);
      cssInjected = true;
    }

    function sanitizeSnippet(text) {
      const escaped = String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      return escaped.replace(/\[([^\]]*)\]/g, "<mark>$1</mark>");
    }

    function normalizeSelection(text) {
      return String(text ?? "").replace(/\s+/g, " ").trim();
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

    /** Load the pdfjs runtime once per page via the authenticated channel. */
    let pdfjsCache = null;
    async function loadPdfjs(sessionId) {
      if (pdfjsCache) return pdfjsCache;
      const runtime = await callRemote(sessionId, "getPdfRuntime");
      const mainUrl = URL.createObjectURL(new Blob([runtime.pdfMainSource], { type: "text/javascript" }));
      const workerUrl = URL.createObjectURL(new Blob([runtime.pdfWorkerSource], { type: "text/javascript" }));
      const pdfjs = await import(mainUrl);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      pdfjsCache = { pdfjs, workerUrl, sessionId };
      return pdfjsCache;
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

    function Badge({ children, style }) {
      return h("span", { style: { ...styles.badge, ...(style ?? null) } }, children);
    }

    function IconButton({ children, onClick, title, danger, primary, disabled, style }) {
      return h("button", {
        type: "button", title, disabled,
        style: {
          ...styles.button,
          ...(danger ? styles.danger : null),
          ...(primary ? styles.primary : null),
          ...(disabled ? { opacity: 0.5, cursor: "default" } : null),
          ...(style ?? null),
        },
        onClick,
      }, children);
    }

    function PaperCard({ paper, t, onOpen, onEdit, onDelete }) {
      const fulltext = paper.material === "fulltext";
      const hasPdf = typeof paper.pdfPath === "string" && paper.pdfPath !== "";
      const [confirming, setConfirming] = useState(false);
      const meta = [paper.authors, paper.year, paper.venue].filter(Boolean).join(" · ");
      return h("li", null,
        h("div", { style: styles.card },
          h("div", { style: { display: "flex", gap: 6, alignItems: "baseline" } },
            h("span", { style: { fontWeight: 600, wordBreak: "break-word", flex: 1 } }, paper.title || "(untitled)"),
            h(Badge, null, fulltext ? t("fulltext") : t("metaOnly")),
            hasPdf ? null : h(Badge, { style: styles.badgeMissing }, t("noPdf")),
          ),
          meta ? h("div", { style: styles.muted }, meta) : null,
          h("div", { style: styles.muted }, `${paper.numPages || 0} ${t("pages")}`),
          paper.snippet
            ? h("p", { style: styles.snippet, dangerouslySetInnerHTML: { __html: sanitizeSnippet(paper.snippet) } })
            : null,
          h("div", { style: { ...styles.row, marginTop: 4 } },
            h(IconButton, {
              onClick: () => onOpen({
                paperId: paper.paperId,
                title: paper.title,
                pageIndex: Number.isInteger(paper.pageIndex) ? paper.pageIndex : 0,
                paper,
              }),
              disabled: !hasPdf,
              primary: true,
            }, t("open")),
            h(IconButton, { onClick: () => onEdit(paper) }, t("editMeta")),
            confirming
              ? h(React.Fragment, null,
                h(IconButton, { danger: true, onClick: () => { setConfirming(false); onDelete(paper.paperId); } }, t("confirm")),
                h(IconButton, { onClick: () => setConfirming(false) }, t("cancel")),
              )
              : h(IconButton, { danger: true, onClick: () => setConfirming(true) }, t("delete")),
          ),
        ),
      );
    }

    function MetadataEditor({ paper, t, onSave, onCancel }) {
      const [form, setForm] = useState({
        title: paper.title ?? "",
        authors: paper.authors ?? "",
        year: paper.year ?? "",
        venue: paper.venue ?? "",
        doi: paper.doi ?? "",
        abstract: paper.abstract ?? "",
      });
      const field = (key, label, textarea) => h("label", { style: styles.field },
        h("span", null, label),
        textarea
          ? h("textarea", {
            style: styles.textarea, value: form[key],
            onChange: (event) => setForm({ ...form, [key]: event.target.value }),
          })
          : h("input", {
            style: styles.input, value: form[key],
            onChange: (event) => setForm({ ...form, [key]: event.target.value }),
          }),
      );
      return h("div", { style: { ...styles.card, display: "flex", flexDirection: "column", gap: 6 } },
        h("strong", null, t("editMeta")),
        field("title", t("titleLabel")),
        field("authors", t("authorsLabel")),
        h("div", { style: styles.row },
          h("div", { style: { flex: "0 0 90px" } }, field("year", t("yearLabel"))),
          h("div", { style: { flex: "1 1 140px" } }, field("venue", t("venueLabel"))),
        ),
        field("doi", t("doiLabel")),
        field("abstract", t("abstractLabel"), true),
        h("div", { style: styles.row },
          h(IconButton, { primary: true, onClick: () => onSave(form) }, t("save")),
          h(IconButton, { onClick: onCancel }, t("cancel")),
        ),
      );
    }

    /**
     * Pick a page range and render a selectable text layer over the canvas.
     *
     * Canvas alone is not selectable: without the text layer the reader can be
     * looked at but not quoted from. If the TextLayer API fails (for example a
     * CSP change), the extracted page text is shown in a selectable <pre> so the
     * evidence workflow still works instead of silently breaking.
     */
    function PdfReader({ sessionId, paper, initialPage, highlight, t, onSelectionChange, onClose }) {
      ensureCss();
      const canvasRef = useRef(null);
      const textLayerRef = useRef(null);
      const pageWrapRef = useRef(null);
      const docRef = useRef(null);
      const pdfjsRef = useRef(null);
      const tokenRef = useRef(0);
      const [pageNumber, setPageNumber] = useState(Math.max(1, (initialPage ?? 0) + 1));
      const [numPages, setNumPages] = useState(0);
      const [scale, setScale] = useState(1.15);
      const [pageInput, setPageInput] = useState("");
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [textFallback, setTextFallback] = useState(null);
      const [selected, setSelected] = useState(null);
      const [highlightMissed, setHighlightMissed] = useState(false);

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
            const doc = await pdfjs.getDocument({
              data: new Uint8Array(payload.data),
              BinaryDataFactory: assets.BinaryDataFactory,
              cMapUrl: assets.cMapUrl,
              standardFontDataUrl: assets.standardFontDataUrl,
              cMapPacked: true,
              isEvalSupported: false,
              useWorkerFetch: false,
              enableXfa: false,
            }).promise;
            if (cancelled) return;
            docRef.current = doc;
            setNumPages(doc.numPages);
            setPageNumber((current) => Math.min(Math.max(1, current), doc.numPages));
          } catch (loadError) {
            if (!cancelled) setError(loadError?.message ?? String(loadError));
          } finally {
            if (!cancelled) setLoading(false);
          }
        })();
        return () => { cancelled = true; controller.abort(); };
      }, [sessionId, paper.paperId]);

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
            await page.render({
              canvasContext: context,
              viewport,
              transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
            }).promise;
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
                setTextFallback(text === "" ? `Text layer unavailable: ${layerError?.message ?? layerError}` : text);
              }
            }
            if (!cancelled && token === tokenRef.current) setError(null);
          } catch (renderError) {
            if (!cancelled && token === tokenRef.current) setError(renderError?.message ?? String(renderError));
          }
        })();
        return () => { cancelled = true; };
      }, [pageNumber, scale, numPages, sessionId, paper.paperId, highlight]);

      const onMouseUp = useCallback(() => {
        const layer = textLayerRef.current;
        const selection = window.getSelection();
        if (!layer || !selection || selection.isCollapsed) return;
        const anchor = selection.anchorNode;
        if (anchor && !layer.contains(anchor)) return;
        const text = normalizeSelection(selection.toString());
        if (text === "") return;
        const next = { text: text.slice(0, 2000), pageIndex: pageNumber - 1 };
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

      return h("div", { style: styles.reader },
        h("div", { style: styles.row },
          h(IconButton, { onClick: onClose }, `← ${t("closeReader")}`),
          h("span", { style: styles.muted }, `${t("page")} ${pageNumber} / ${numPages || "?"}`),
          h(IconButton, {
            disabled: pageNumber <= 1,
            onClick: () => { setPageNumber((n) => Math.max(1, n - 1)); setSelected(null); onSelectionChange(null); },
          }, t("prevPage")),
          h(IconButton, {
            disabled: pageNumber >= numPages,
            onClick: () => { setPageNumber((n) => Math.min(numPages, n + 1)); setSelected(null); onSelectionChange(null); },
          }, t("nextPage")),
          h(IconButton, { disabled: scale <= 0.6, onClick: () => setScale((s) => Math.max(0.6, +(s - 0.2).toFixed(2))) }, "−"),
          h("span", { style: styles.muted }, `${Math.round(scale * 100)}%`),
          h(IconButton, { disabled: scale >= 3, onClick: () => setScale((s) => Math.min(3, +(s + 0.2).toFixed(2))) }, "+"),
          h("input", {
            style: { ...styles.input, flex: "0 0 46px", padding: "3px 5px" },
            value: pageInput, placeholder: t("jumpPlaceholder"),
            onChange: (event) => setPageInput(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") goToPage(); },
          }),
          h(IconButton, { onClick: goToPage }, t("jump")),
        ),
        h("div", { style: styles.muted }, paper.title || paper.paperId),
        highlightMissed ? h("p", { style: styles.note }, "已打开对应页，但未在文本层中定位到该引文。") : null,
        loading ? h("p", { style: styles.muted }, "…") : null,
        error ? h("p", { style: styles.error }, error) : null,
        h("div", { style: styles.canvasWrap },
          h("div", { ref: pageWrapRef, style: styles.pageWrap },
            h("canvas", { ref: canvasRef, style: { display: "block" } }),
            h("div", { ref: textLayerRef, className: "pt-textLayer", onMouseUp }),
          ),
        ),
        textFallback !== null
          ? h("div", { style: styles.group },
            h("p", { style: styles.muted }, "文本面板模式：PDF 文本层无法叠加，改为显示抽取文本，仍可选中。"),
            h("pre", {
              style: styles.pre,
              onMouseUp: () => {
                const text = normalizeSelection(window.getSelection()?.toString() ?? "");
                if (text === "") return;
                const next = { text: text.slice(0, 2000), pageIndex: pageNumber - 1 };
                setSelected(next);
                onSelectionChange(next);
              },
            }, textFallback),
          )
          : null,
        selected
          ? h("div", { style: styles.selectionBar },
            h("span", { style: { flex: 1, fontSize: "0.85em" } }, `${t("selected")} · ${t("page")} ${selected.pageIndex + 1} · ${selected.text.slice(0, 80)}…`),
          )
          : h("p", { style: styles.muted }, t("noSelection")),
      );
    }

    function StanceBadge({ stance, t }) {
      const label = stance === "support"
        ? t("support")
        : stance === "conflict"
          ? t("conflict")
          : stance === "covered"
            ? t("covered")
            : stance === "empty"
              ? t("emptyCoverage")
              : t("notFound");
      const style = stance === "support"
        ? styles.badgeSupport
        : stance === "conflict"
          ? styles.badgeConflict
          : stance === "covered"
            ? styles.badgeSupport
            : styles.badgeMissing;
      return h(Badge, { style }, label);
    }

    function Body({ sessionId, inputActions, t }) {
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
      const [busy, setBusy] = useState(null);
      const [note, setNote] = useState("");
      const [error, setError] = useState(null);
      const [evidence, setEvidence] = useState([]);
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

      const loadEvidence = useCallback(async () => {
        if (!sessionId) return;
        const result = await callRemote(sessionId, "listEvidence", { limit: 1000 });
        setEvidence(result.evidence ?? []);
      }, [sessionId]);

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
        } catch (statusError) {
          setError(statusError?.message ?? String(statusError));
        }
      }, [sessionId, loadEvidence]);

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
            const result = await callRemote(sessionId, "searchExternal", { query, limit: 10 });
            setCandidates(result.candidates ?? []);
            setFailures(result.failures ?? []);
            setHits(null);
            setPicked({});
          } else if (mode === "cnki") {
            const result = await callRemote(sessionId, "cnkiSearch", { query, limit: 20 });
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
            setStatus((current) => ({ ...(current ?? {}), library: result.library }));
            setCandidates(null);
            setFailures([]);
          }
        } catch (searchError) {
          setError(searchError?.message ?? String(searchError));
        } finally {
          setBusy(null);
        }
      }, [sessionId, query, mode]);

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
                problems.push(`${candidate.title}: 没有可下载链接`);
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
                else problems.push(`${candidate.title}: ${result.reason ?? "下载失败"}`);
              } catch (downloadError) {
                problems.push(`${candidate.title}: ${downloadError?.message ?? String(downloadError)}`);
              }
            }
            setNote(`${t("added")} ${added}${problems.length > 0 ? ` · ${problems.length} 失败` : ""}`);
            if (problems.length > 0) setError(problems.slice(0, 3).join("; "));
            setPicked({});
          } else {
            const result = await callRemote(sessionId, "addCandidates", { candidates: chosen });
            setNote(`${t("added")} ${result.imported?.length ?? 0}`);
            setPicked({});
            setCandidates(candidates.filter((_candidate, index) => !picked[index]));
          }
          await refresh();
        } catch (addError) {
          setError(addError?.message ?? String(addError));
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
          const files = [];
          for (let index = 0; index < fileList.length; index += 1) {
            const file = fileList[index];
            setNote(`${t("importing")} ${index + 1}/${fileList.length}`);
            const buffer = await file.arrayBuffer();
            // The wire is JSON: send a number array, not a Uint8Array (which
            // would serialize as an object and fail the Host's byte parser).
            files.push({ name: file.name, data: Array.from(new Uint8Array(buffer)) });
          }
          const result = await callRemote(sessionId, "importPdf", { files });
          const okCount = result.imported?.length ?? 0;
          const failCount = result.failed?.length ?? 0;
          await refresh();
          setNote(`✓ ${okCount}${failCount > 0 ? ` / ✗ ${failCount}` : ""}`);
          setHits(null);
          setError(failCount > 0 ? result.failed.map((item) => `${item.filename}: ${item.reason}`).join("; ") : null);
        } catch (importError) {
          setError(importError?.message ?? String(importError));
        } finally {
          setBusy(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }
      }, [sessionId, t, refresh]);

      const saveMetadata = useCallback(async (form) => {
        if (!sessionId || !editing) return;
        setBusy("metadata");
        try {
          const result = await callRemote(sessionId, "updatePaper", { paperId: editing.paperId, ...form });
          setEditing(null);
          setPapers((current) => current.map((paper) => (paper.paperId === result.paper.paperId ? result.paper : paper)));
          setNote(t("save"));
        } catch (saveError) {
          setError(saveError?.message ?? String(saveError));
        } finally {
          setBusy(null);
        }
      }, [sessionId, editing, t]);

      const deletePaper = useCallback(async (paperId) => {
        if (!sessionId) return;
        setBusy("delete");
        try {
          await callRemote(sessionId, "deletePaper", { paperId });
          if (reader?.paperId === paperId) setReader(null);
          setHits((current) => (current ? current.filter((hit) => hit.paperId !== paperId) : current));
          await refresh();
        } catch (deleteError) {
          setError(deleteError?.message ?? String(deleteError));
        } finally {
          setBusy(null);
        }
      }, [sessionId, reader, refresh]);

      const insertToChat = useCallback((text) => {
        const actions = inputActions;
        if (!actions) {
          setError("inputActions unavailable in this seat");
          return false;
        }
        try {
          const span = actions.captureInsertion();
          actions.insertText({ ...span, text });
          setNote(t("sentToChat"));
          return true;
        } catch (insertError) {
          setError(insertError?.message ?? String(insertError));
          return false;
        }
      }, [inputActions, t]);

      const askSelection = useCallback(() => {
        if (!selection || !reader) return;
        const text = question.trim() === "" ? t("askHint") : question.trim();
        const composed = [
          `【论文】${reader.title || reader.paperId}`,
          `【页码】第 ${selection.pageIndex + 1} 页`,
          `【引文】"${selection.text}"`,
          `【问题】${text}`,
        ].join("\n");
        if (insertToChat(composed)) setQuestion("");
      }, [selection, reader, question, insertToChat, t]);

      const saveEvidence = useCallback(async () => {
        if (!selection || !reader || !sessionId) return;
        setBusy("evidence");
        try {
          const result = await callRemote(sessionId, "addEvidence", {
            paperId: reader.paperId,
            pageIndex: selection.pageIndex,
            quote: selection.text,
          });
          setNote(`${t("evidenceSaved")} #${String(result.evidenceId).slice(0, 8)}${result.anchored ? "" : ` · ${t("evidenceUnanchored")}`}`);
          await loadEvidence();
        } catch (evidenceError) {
          setError(evidenceError?.message ?? String(evidenceError));
        } finally {
          setBusy(null);
        }
      }, [selection, reader, sessionId, t, loadEvidence]);

      const collectEvidence = useCallback(async () => {
        if (!sessionId || collectQuery.trim() === "") return;
        setBusy("collect");
        setError(null);
        try {
          const result = await callRemote(sessionId, "collectEvidence", { query: collectQuery.trim(), limit: 20 });
          setNote(`${t("added")} ${result.evidence?.length ?? 0} ${t("evidenceCount")}`);
          await loadEvidence();
        } catch (collectError) {
          setError(collectError?.message ?? String(collectError));
        } finally {
          setBusy(null);
        }
      }, [sessionId, collectQuery, t, loadEvidence]);

      const removeEvidence = useCallback(async (evidenceId) => {
        if (!sessionId) return;
        try {
          await callRemote(sessionId, "deleteEvidence", { evidenceId });
          await loadEvidence();
        } catch (removeError) {
          setError(removeError?.message ?? String(removeError));
        }
      }, [sessionId, loadEvidence]);

      const checkMatrix = useCallback(async (claim) => {
        if (!sessionId) return;
        setBusy("matrix");
        setError(null);
        try {
          const result = await callRemote(sessionId, "reviewMatrix", { claim });
          setMatrix(result);
        } catch (matrixError) {
          setError(matrixError?.message ?? String(matrixError));
        } finally {
          setBusy(null);
        }
      }, [sessionId]);

      const buildOutline = useCallback(async () => {
        if (!sessionId) return;
        setBusy("outline");
        try {
          const result = await callRemote(sessionId, "reviewOutline");
          setOutline(result);
        } catch (outlineError) {
          setError(outlineError?.message ?? String(outlineError));
        } finally {
          setBusy(null);
        }
      }, [sessionId]);

      const evidenceIds = useMemo(() => evidence.map((row) => row.evidenceId), [evidence]);
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
            style: citationStyle, locale: citationLocale,
          });
          setCitation(result);
        } catch (citationError) {
          setError(citationError?.message ?? String(citationError));
        } finally {
          setBusy(null);
        }
      }, [sessionId, citationStyle, citationLocale]);

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
          setError(exportError?.message ?? String(exportError));
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

      const cmapFailure = failures.map((failure) => `${failure.source} (${failure.reason})`).join(", ");
      const paperById = new Map(papers.map((paper) => [paper.paperId, paper]));
      // Search hits carry only display fields; merge in the stored row so the
      // card knows whether a PDF exists before offering the reader.
      const list = hits === null
        ? papers
        : hits.map((hit) => ({ ...(paperById.get(hit.paperId) ?? {}), ...hit }));

      const renderLibrary = () => h("div", { style: styles.group },
        h("div", { style: styles.row },
          h("input", {
            style: styles.input, value: query, placeholder: t("searchPlaceholder"),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") doSearch(); },
          }),
          h(IconButton, { primary: true, onClick: doSearch, disabled: busy !== null || query.trim() === "" },
            busy === "search" ? t("searching") : t("search")),
          hits !== null ? h(IconButton, { onClick: () => { setHits(null); setQuery(""); } }, t("clear")) : null,
        ),
        h("div", { style: styles.row },
          h(IconButton, { primary: mode === "library", onClick: () => { setMode("library"); setCandidates(null); setFailures([]); } }, t("library")),
          h(IconButton, { primary: mode === "external", onClick: () => { setMode("external"); setHits(null); } }, t("external")),
          h(IconButton, { primary: mode === "cnki", onClick: () => { setMode("cnki"); setHits(null); } }, t("cnki")),
          h("span", { style: styles.spacer }),
          h(IconButton, { onClick: () => fileInputRef.current?.click(), disabled: busy !== null }, busy === "import" ? t("importing") : t("import")),
          h("input", {
            ref: fileInputRef, type: "file", accept: "application/pdf", multiple: true,
            style: { display: "none" },
            onChange: (event) => doImport(event.target.files),
          }),
        ),
        (mode === "external" || mode === "cnki") ? h("div", { style: styles.row },
          h("span", { style: styles.muted }, cnki === null ? t("cnki") : `${t("cnki")} · ${cnki.loggedIn ? t("cnkiConnected") : t("cnkiNotLoggedIn")}`),
          h("span", { style: styles.spacer }),
          h(IconButton, {
            disabled: busy !== null,
            onClick: async () => {
              setBusy("cnki");
              setNote(t("cnkiConnecting"));
              try {
                const state = await callRemote(sessionId, "cnkiConnect");
                setCnki(state);
                setNote(state.hint ?? "");
                if (state.ok === false) setError(state.reason ?? "CNKI unavailable");
              } catch (connectError) {
                setError(connectError?.message ?? String(connectError));
              } finally {
                setBusy(null);
              }
            },
          }, cnki?.loggedIn ? t("cnkiRecheck") : t("cnkiConnect")),
        ) : null,
        failures.length > 0 ? h("p", { style: styles.note }, `${t("sourcesFailed")}: ${cmapFailure}`) : null,
        editing ? h(MetadataEditor, { paper: editing, t, onSave: saveMetadata, onCancel: () => setEditing(null) }) : null,
        reader ? h(PdfReader, {
          sessionId, paper: reader, initialPage: reader.pageIndex,
          highlight: readerHighlight,
          t,
          onSelectionChange: setSelection,
          onClose: () => { setReader(null); setSelection(null); },
        }) : null,
        candidates !== null ? h("div", { style: styles.group },
          h("div", { style: styles.row },
            h("strong", null, `${mode === "cnki" ? t("cnki") : t("external")} · ${candidates.length}`),
            h("span", { style: styles.spacer }),
            h(IconButton, {
              primary: true, disabled: busy !== null || !candidates.some((_candidate, index) => picked[index]),
              onClick: addPicked,
            }, busy === "add" ? t("downloading") : t("addSelected")),
          ),
          mode === "external" ? h("p", { style: styles.muted }, t("metadataOnlyNote")) : null,
          candidates.length === 0
            ? h("p", { style: styles.muted }, t("noCandidates"))
            : h("ul", { style: styles.list }, candidates.map((candidate, index) => h("li", {
              key: `${candidate.doi || candidate.title}-${index}`,
            },
              h("label", { style: { ...styles.card, display: "flex", gap: 8, alignItems: "flex-start" } },
                h("input", {
                  type: "checkbox", checked: picked[index] === true,
                  onChange: (event) => setPicked((current) => ({ ...current, [index]: event.target.checked })),
                }),
                h("span", { style: { flex: 1 } },
                  h("span", { style: { fontWeight: 600, wordBreak: "break-word", display: "block" } }, candidate.title),
                  h("span", { style: styles.muted }, [candidate.authors, candidate.year, candidate.venue, candidate.source, candidate.doi].filter(Boolean).join(" · ")),
                  candidate.abstract ? h("span", { style: styles.snippet }, candidate.abstract.slice(0, 220)) : null,
                ),
              ),
            ))),
        ) : null,
        selection && !reader ? null : selection && reader
          ? h("div", { style: styles.askBox },
            h("p", { style: styles.muted }, `${t("selected")} · ${t("page")} ${selection.pageIndex + 1} · ${selection.text.slice(0, 70)}…`),
            h("div", { style: styles.row },
              h("input", {
                style: styles.input, value: question, placeholder: t("askPlaceholder"),
                onChange: (event) => setQuestion(event.target.value),
                onKeyDown: (event) => { if (event.key === "Enter") askSelection(); },
              }),
              h(IconButton, { primary: true, onClick: askSelection }, t("ask")),
              h(IconButton, { onClick: saveEvidence, disabled: busy !== null }, t("evidence")),
            ),
          )
          : null,
        reader ? null : h("div", { style: styles.group },
          h("p", { style: styles.muted }, hits !== null
            ? `${hits.length} ${t("total")}`
            : `${papers.length} ${t("papers")} · ${status?.library?.pages ?? 0} ${t("pagesLabel")}`),
          list.length === 0
            ? h("p", { style: styles.muted }, hits !== null ? t("noResults") : t("empty"))
            : h("ul", { style: styles.list }, list.map((paper) => h(PaperCard, {
              key: paper.paperId,
              paper,
              t,
              onOpen: openReader,
              onEdit: setEditing,
              onDelete: deletePaper,
            }))),
        ),
      );

      const renderEvidence = () => {
        const grouped = new Map();
        for (const row of evidence) {
          if (!grouped.has(row.paperId)) grouped.set(row.paperId, []);
          grouped.get(row.paperId).push(row);
        }
        return h("div", { style: styles.group },
          h("div", { style: styles.row },
            h("input", {
              style: styles.input, value: collectQuery, placeholder: t("collectPlaceholder"),
              onChange: (event) => setCollectQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") collectEvidence(); },
            }),
            h(IconButton, { primary: true, onClick: collectEvidence, disabled: busy !== null || collectQuery.trim() === "" }, t("collect")),
          ),
          h("p", { style: styles.muted }, t("collectHint")),
          evidence.length === 0
            ? h("p", { style: styles.muted }, t("evidenceEmpty"))
            : [...grouped.entries()].map(([paperId, rows]) => h("div", { key: paperId, style: styles.group },
              h("strong", { style: { fontSize: "0.9em" } }, rows[0].paperTitle || paperId),
              h("span", { style: styles.muted }, ` · ${rows.length} ${t("evidenceCount")}`),
              rows.map((row) => h("div", { key: row.evidenceId, style: styles.evidenceRow },
                h("div", { style: { flex: 1 } },
                  h("div", { style: styles.muted }, `${t("page")} ${row.pageIndex + 1} · ${row.evidenceId.slice(0, 8)} · ${row.charStart >= 0 ? t("evidenceAnchored") : t("evidenceUnanchored")}`),
                  h("p", { style: styles.quote }, row.quote),
                ),
                h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                  h(IconButton, {
                    onClick: () => openReader({ paperId: row.paperId, title: row.paperTitle, pageIndex: row.pageIndex, quote: row.quote, paper: { paperId: row.paperId, title: row.paperTitle } }),
                  }, t("jumpToPage")),
                  h(IconButton, { danger: true, onClick: () => removeEvidence(row.evidenceId) }, t("delete")),
                ),
              )),
            )),
          h("div", { style: { borderTop: "1px solid var(--dsw-alias-border, #8884)", paddingTop: 6, marginTop: 2 } },
            h("strong", null, t("matrix")),
            h("div", { style: styles.row },
              h("input", {
                style: styles.input, value: matrixClaim, placeholder: t("claimPlaceholder"),
                onChange: (event) => setMatrixClaim(event.target.value),
                onKeyDown: (event) => { if (event.key === "Enter") checkMatrix(matrixClaim); },
              }),
              h(IconButton, { primary: true, onClick: () => checkMatrix(matrixClaim), disabled: busy !== null }, t("checkStance")),
              h(IconButton, { onClick: () => checkMatrix(""), disabled: busy !== null }, t("coverage")),
            ),
            matrix ? h("div", { style: styles.group },
              h("p", { style: styles.note }, matrix.text?.split("\n").slice(0, 2).join(" ") ?? ""),
              (matrix.rows ?? []).length === 0
                ? h("p", { style: styles.muted }, t("noResults"))
                : h("ul", { style: styles.list }, matrix.rows.map((row) => h("li", { key: row.paperId, style: styles.evidenceRow },
                  h("div", { style: { flex: 1 } },
                    h("div", { style: { display: "flex", gap: 6, alignItems: "baseline" } },
                      h("span", { style: { flex: 1, fontSize: "0.88em" } }, row.title),
                      h(StanceBadge, { stance: row.stance, t }),
                    ),
                    h("div", { style: styles.muted }, `${row.supportCount ?? 0} ${t("support")} · ${row.conflictCount ?? 0} ${t("conflict")} · ${row.notFoundCount ?? 0} ${t("notFound")}`),
                  ),
                  row.evidenceIds?.[0] ? h(IconButton, {
                    onClick: () => {
                      const target = evidence.find((item) => item.evidenceId === row.evidenceIds[0]);
                      if (target) openReader({ paperId: target.paperId, title: target.paperTitle, pageIndex: target.pageIndex, quote: target.quote, paper: { paperId: target.paperId, title: target.paperTitle } });
                    },
                  }, t("jumpToPage")) : null,
                ))),
            ) : null,
          ),
        );
      };

      const renderReview = () => h("div", { style: styles.group },
        h("div", { style: styles.row },
          h("strong", null, t("outline")),
          h("span", { style: styles.spacer }),
          h(IconButton, { onClick: buildOutline, disabled: busy !== null }, t("generateOutline")),
          outline?.text ? h(IconButton, { onClick: sendOutline, disabled: !inputActions }, t("sendToChat")) : null,
        ),
        outline
          ? h("pre", { style: styles.pre }, outline.text)
          : h("p", { style: styles.muted }, t("selectEvidence")),
        h("div", { style: { borderTop: "1px solid var(--dsw-alias-border, #8884)", paddingTop: 6 } },
          h("strong", null, t("citations")),
          h("div", { style: styles.row },
            h("span", { style: styles.muted }, t("style")),
            h("select", {
              style: { ...styles.input, flex: "0 1 160px" },
              value: citationStyle,
              onChange: (event) => setCitationStyle(event.target.value),
            }, (status?.styles ?? ["apa", "ieee", "gb-t-7714", "gb-t-7714-author-date"]).map((style) => h("option", { key: style, value: style }, style))),
            h("span", { style: styles.muted }, t("locale")),
            h("select", {
              style: { ...styles.input, flex: "0 1 100px" },
              value: citationLocale,
              onChange: (event) => setCitationLocale(event.target.value),
            },
              h("option", { value: "zh-CN" }, "zh-CN"),
              h("option", { value: "en-US" }, "en-US"),
            ),
            h(IconButton, { primary: true, onClick: renderCitations, disabled: busy !== null }, t("generateCitations")),
          ),
          h("p", { style: styles.muted }, evidence.length === 0 ? t("noEvidence") : `${evidence.length} ${t("evidenceCount")} · ${t("selectEvidence")}`),
          citation?.ok
            ? h("div", { style: styles.group },
              h("span", { style: styles.muted }, t("inText")),
              h("pre", { style: styles.pre }, citation.citation),
              h("span", { style: styles.muted }, t("bibliography")),
              h("pre", { style: styles.pre }, citation.bibliography),
            )
            : citation && citation.ok === false ? h("p", { style: styles.error }, citation.text ?? "citation failed") : null,
          h("div", { style: styles.row },
            h(IconButton, { primary: true, onClick: doExport, disabled: busy !== null || evidence.length === 0 }, busy === "export" ? t("exporting") : t("export")),
            h(IconButton, { onClick: copyMarkdown, disabled: !exported?.markdown && !citation?.bibliography }, t("copy")),
          ),
          exported?.ok
            ? h("div", { style: styles.group },
              h("p", { style: styles.note }, `${t("exported")}: ${exported.paths?.dir ?? ""}`),
              exported.warnings?.length > 0
                ? h("div", null,
                  h("p", { style: styles.muted }, t("warnings")),
                  h("ul", { style: styles.list }, exported.warnings.map((warning, index) => h("li", { key: index, style: styles.note }, warning))),
                )
                : h("p", { style: styles.note }, t("noWarnings")),
            )
            : null,
        ),
      );

      return h("div", { style: styles.root, "data-paper-tool": view },
        h("div", { style: styles.header },
          h("strong", null, t("title")),
          status ? h("span", { style: styles.muted }, `${status.library?.papers ?? 0} ${t("papers")} · ${status.library?.pages ?? 0} ${t("pagesLabel")} · ${status.library?.evidence ?? 0} ${t("evidenceCount")}`) : null,
          h("span", { style: styles.spacer }),
          h(IconButton, { onClick: refresh, disabled: busy !== null }, t("reload")),
        ),
        h("div", { style: styles.nav },
          h("button", { type: "button", style: { ...styles.navItem, ...(view === "library" ? styles.navActive : null) }, onClick: () => setView("library") }, t("library")),
          h("button", { type: "button", style: { ...styles.navItem, ...(view === "evidence" ? styles.navActive : null) }, onClick: () => setView("evidence") }, t("evidenceTab")),
          h("button", { type: "button", style: { ...styles.navItem, ...(view === "review" ? styles.navActive : null) }, onClick: () => setView("review") }, t("reviewTab")),
        ),
        error ? h("p", { style: styles.error }, error) : null,
        note ? h("p", { style: styles.note }, note) : null,
        view === "library" ? renderLibrary() : view === "evidence" ? renderEvidence() : renderReview(),
      );
    }

    function apply(ctx) {
      sharedCtx = ctx;
      ctx.effect(() => ctx.locale.register(NS, DICTS));
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: KIND,
        title: () => "论文",
        keepMounted: true,
        guide: [{ id: "paper-tool", order: 50, title: () => "论文" }],
      }), "paper-tool: tab type");
      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: TAB_ID,
        locale: NS,
      }, Body)), "paper-tool: tab body");
    }

    return {
      inject: ["locale", "slots", "sidebarRightTabs", "connection"],
      apply,
    };
  },
});

// Browser client for @local/paper-tool.
//
// Assembly follows the verified shape of @local/dsh-zotero-workbench:
// - lazy factory registered with window.__ModuleLoader__.load
// - right-sidebar tab type via ctx.sidebarRightTabs.register + keyed body via
//   the `sidebar.right.pane.tab` seat
// - session props (sessionId) arrive through ctx.slots.injectScope("session")
// - Remote calls over the authenticated Connection RPC channel
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
        papers: "篇",
        pagesLabel: "页",
        import: "导入 PDF",
        importing: "导入中…",
        searchPlaceholder: "搜索标题、摘要或全文…",
        search: "搜索",
        searching: "搜索中…",
        empty: "库是空的。点「导入 PDF」把论文放进来。",
        noResults: "没有匹配结果。",
        fulltext: "有全文",
        metaOnly: "仅书目",
        page: "第",
        reading: "阅读中",
        closeReader: "关闭",
        prevPage: "上一页",
        nextPage: "下一页",
        zoomIn: "放大",
        zoomOut: "缩小",
        ask: "问选中内容",
        askPlaceholder: "就这段内容提问…",
        selected: "已选中",
        noSelection: "先在 PDF 里选中文字",
        sending: "发送中…",
        askHint: "提问会带上论文、页码与引文",
        delete: "删除",
        evidence: "存为证据",
        evidenceSaved: "已存为证据",
        statusError: "连接失败",
        retry: "重试",
        reload: "刷新库",
        local: "本库",
        external: "外部",
        externalSearch: "去库里找新文献",
        externalSearching: "检索中…",
        addSelected: "加入文献库",
        added: "已加入",
        noCandidates: "外部检索没有结果。",
        sourcesFailed: "部分来源失败",
        cnki: "知网",
        cnkiConnect: "连接知网",
        cnkiRecheck: "重新检测",
        cnkiConnected: "已登录",
        cnkiNotLoggedIn: "未登录",
        cnkiConnecting: "正在打开浏览器…",
      },
      en: {
        title: "Papers",
        library: "Library",
        papers: "papers",
        pagesLabel: "pages",
        import: "Import PDF",
        importing: "Importing…",
        searchPlaceholder: "Search title, abstract or full text…",
        search: "Search",
        searching: "Searching…",
        empty: "Library is empty. Click “Import PDF” to add papers.",
        noResults: "No matches.",
        fulltext: "full text",
        metaOnly: "metadata only",
        page: "page",
        reading: "Reading",
        closeReader: "Close",
        prevPage: "Prev",
        nextPage: "Next",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        ask: "Ask about selection",
        askPlaceholder: "Ask about the selected text…",
        selected: "Selected",
        noSelection: "Select text in the PDF first",
        sending: "Sending…",
        askHint: "The question carries the paper, page and quote",
        delete: "Delete",
        evidence: "Save as evidence",
        evidenceSaved: "Saved as evidence",
        statusError: "Connection failed",
        retry: "Retry",
        reload: "Reload library",
        local: "Local",
        external: "External",
        externalSearch: "Find new papers",
        externalSearching: "Searching…",
        addSelected: "Add to library",
        added: "Added",
        noCandidates: "No external results.",
        sourcesFailed: "Some sources failed",
        cnki: "CNKI",
        cnkiConnect: "Connect CNKI",
        cnkiRecheck: "Re-check",
        cnkiConnected: "Logged in",
        cnkiNotLoggedIn: "Not logged in",
        cnkiConnecting: "Opening browser…",
      },
    };

    let sharedCtx = null;

    async function callRemote(sessionId, method, args = {}, signal) {
      const envelope = await sharedCtx.connection.rpc.call(
        "/api",
        `paperTool/${method}`,
        { args: { paperSessionId: sessionId, ...args } },
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
        display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px",
        minHeight: "100%", font: "inherit", color: "inherit", boxSizing: "border-box",
      },
      row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
      input: {
        flex: "1 1 140px", minWidth: 0, padding: "5px 8px", fontSize: "inherit",
        color: "inherit", background: "transparent", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #8884)",
      },
      button: {
        padding: "5px 10px", fontSize: "inherit", color: "inherit", cursor: "pointer",
        background: "transparent", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #8884)",
      },
      muted: { fontSize: "0.85em", opacity: 0.7, margin: 0 },
      list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
      card: {
        padding: "7px 9px", borderRadius: 8, cursor: "pointer",
        border: "1px solid var(--dsw-alias-border, #8884)",
      },
      snippet: { fontSize: "0.85em", opacity: 0.8, margin: "3px 0 0", wordBreak: "break-word" },
      badge: {
        fontSize: "0.75em", padding: "1px 6px", borderRadius: 999,
        border: "1px solid var(--dsw-alias-border, #8884)", opacity: 0.85,
      },
      reader: {
        display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--dsw-alias-border, #8884)",
        paddingTop: 10, marginTop: 4,
      },
      canvasWrap: {
        overflow: "auto", maxHeight: "52vh", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #8884)",
        background: "var(--dsw-alias-bg, #fff)",
        display: "flex", justifyContent: "center", padding: 6,
      },
      askBox: { display: "flex", flexDirection: "column", gap: 6 },
      active: {
        borderColor: "var(--dsw-alias-accent, #3b82f6)",
        background: "var(--dsw-alias-accent-soft, #3b82f61a)",
      },
      error: { fontSize: "0.85em", color: "var(--dsw-alias-danger, #d33)", margin: 0 },
    };

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

    /**
     * A BinaryDataFactory that serves CMaps and standard fonts from the Host.
     *
     * pdfjs resolves `cmaps/` against a base URL, and a Blob-URL module has no
     * base to resolve against, so the Host serves the bytes instead. Without
     * CMaps a Chinese PDF renders blank — this is not optional for CJK.
     *
     * The factory contract is `_fetch(url, kind) -> Uint8Array`; the URL is
     * built as `${cMapUrl}${filename}`, so each base points at a fake prefix
     * that the override maps back to a real asset name.
     */
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

      class HostBinaryDataFactory extends pdfjs.DOMBinaryDataFactory {
        async _fetch(url, kind) {
          if (kind === "cMapUrl") {
            return await load("cmaps", url.slice(CMAP_BASE.length));
          }
          if (kind === "standardFontDataUrl") {
            return await load("standard_fonts", url.slice(FONT_BASE.length));
          }
          throw new Error(`unsupported binary asset: ${kind}`);
        }
      }

      return {
        BinaryDataFactory: HostBinaryDataFactory,
        cMapUrl: CMAP_BASE,
        standardFontDataUrl: FONT_BASE,
      };
    }

    function PaperCard({ hit, t, onOpen, onDelete }) {
      const badge = hit.material === "fulltext" ? t("fulltext") : t("metaOnly");
      return h("li", null,
        h("div", {
          role: "button", tabIndex: 0, style: styles.card,
          onClick: () => onOpen(hit.paperId),
          onKeyDown: (event) => { if (event.key === "Enter") onOpen(hit.paperId); },
        },
          h("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
            h("span", { style: { fontWeight: 600, wordBreak: "break-word", flex: 1 } }, hit.title || "(untitled)"),
            h("span", { style: styles.badge }, badge),
          ),
          h("div", { style: styles.muted },
            [hit.year, hit.pageIndex === null || hit.pageIndex === undefined ? null : `${t("page")} ${hit.pageIndex + 1}`]
              .filter(Boolean).join(" · ")),
          hit.snippet ? h("p", { style: styles.snippet, dangerouslySetInnerHTML: { __html: sanitizeSnippet(hit.snippet) } }) : null,
        ),
        h("div", { style: { display: "flex", gap: 6, marginTop: 3 } },
          h("button", {
            type: "button", style: { ...styles.button, fontSize: "0.8em", padding: "2px 7px" },
            onClick: (event) => { event.stopPropagation(); onDelete(hit.paperId); },
          }, t("delete")),
        ),
      );
    }

    /** Escape everything, then restore only the [..] snippet markers. */
    function sanitizeSnippet(text) {
      const escaped = String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      return escaped.replace(/\[([^\]]*)\]/g, "<mark>$1</mark>");
    }

    function PdfReader({ sessionId, paperId, t, onSelectionChange, onClose }) {
      const canvasRef = useRef(null);
      const docRef = useRef(null);
      const [pageNumber, setPageNumber] = useState(1);
      const [numPages, setNumPages] = useState(0);
      const [scale, setScale] = useState(1.2);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);

      useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        (async () => {
          try {
            setLoading(true);
            const { pdfjs, workerUrl } = await loadPdfjs(sessionId);
            const payload = await callRemote(sessionId, "readPaperBytes", { paperId }, controller.signal);
            if (cancelled) return;
            // pdfjs resolves its worker from GlobalWorkerOptions; passing a
            // Worker instance as `port` would be wrong (that field wants a
            // MessagePort), so hand the browser the worker URL instead.
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
            setPageNumber(1);
            setError(null);
          } catch (loadError) {
            if (!cancelled) setError(loadError?.message ?? String(loadError));
          } finally {
            if (!cancelled) setLoading(false);
          }
        })();
        return () => { cancelled = true; controller.abort(); };
      }, [sessionId, paperId]);

      useEffect(() => {
        const doc = docRef.current;
        if (!doc || numPages === 0) return undefined;
        let cancelled = false;
        (async () => {
          try {
            const page = await doc.getPage(pageNumber);
            const viewport = page.getViewport({ scale });
            const canvas = canvasRef.current;
            if (!canvas || cancelled) return;
            const context = canvas.getContext("2d");
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.floor(viewport.width * ratio);
            canvas.height = Math.floor(viewport.height * ratio);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            await page.render({
              canvasContext: context,
              viewport,
              transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
            }).promise;
            if (!cancelled) setError(null);
          } catch (renderError) {
            if (!cancelled) setError(renderError?.message ?? String(renderError));
          }
        })();
        return () => { cancelled = true; };
      }, [pageNumber, scale, numPages]);

      return h("div", { style: styles.reader },
        h("div", { style: styles.row },
          h("button", { type: "button", style: styles.button, onClick: onClose }, t("closeReader")),
          h("span", { style: styles.muted }, `${t("page")} ${pageNumber} / ${numPages || "?"}`),
          h("button", {
            type: "button", style: styles.button, disabled: pageNumber <= 1,
            onClick: () => setPageNumber((n) => Math.max(1, n - 1)),
          }, t("prevPage")),
          h("button", {
            type: "button", style: styles.button, disabled: pageNumber >= numPages,
            onClick: () => setPageNumber((n) => Math.min(numPages, n + 1)),
          }, t("nextPage")),
          h("button", {
            type: "button", style: styles.button, disabled: scale <= 0.6,
            onClick: () => setScale((s) => Math.max(0.6, +(s - 0.2).toFixed(2))),
          }, t("zoomOut")),
          h("button", {
            type: "button", style: styles.button, disabled: scale >= 3,
            onClick: () => setScale((s) => Math.min(3, +(s + 0.2).toFixed(2))),
          }, t("zoomIn")),
        ),
        loading ? h("p", { style: styles.muted }, "…") : null,
        error ? h("p", { style: styles.error }, error) : null,
        h("div", { style: styles.canvasWrap },
          h("canvas", {
            ref: canvasRef,
            onMouseUp: () => {
              const selection = window.getSelection();
              const text = selection?.toString()?.trim() ?? "";
              onSelectionChange(text === "" ? null : { text, pageIndex: pageNumber - 1 });
            },
          }),
        ),
      );
    }

    function LibraryTabBody({ sessionId, inputActions, t }) {
      const [query, setQuery] = useState("");
      const [mode, setMode] = useState("library");
      const [hits, setHits] = useState(null);
      const [candidates, setCandidates] = useState(null);
      const [picked, setPicked] = useState({});
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      const [openPaper, setOpenPaper] = useState(null);
      const [selection, setSelection] = useState(null);
      const [question, setQuestion] = useState("");
      const [note, setNote] = useState("");
      const [failures, setFailures] = useState([]);
      const [cnki, setCnki] = useState(null);
      const fileInputRef = useRef(null);

      const refresh = useCallback(async () => {
        if (!sessionId) return;
        try {
          const result = await callRemote(sessionId, "status");
          setStatus(result.library);
          setError(null);
        } catch (statusError) {
          setError(statusError?.message ?? String(statusError));
        }
      }, [sessionId]);

      useEffect(() => { refresh(); }, [refresh]);

      // CNKI state is polled lazily: only when the external tab is open, so an
      // idle sidebar never spawns a browser check.
      useEffect(() => {
        if (mode !== "external" || !sessionId) return undefined;
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

      const connectCnki = useCallback(async () => {
        if (!sessionId) return;
        setBusy(true);
        setNote(t("cnkiConnecting"));
        try {
          const state = await callRemote(sessionId, "cnkiConnect");
          setCnki(state);
          setNote(state.hint ?? "");
          setError(state.ok === false ? (state.reason ?? "CNKI unavailable") : null);
        } catch (connectError) {
          setError(connectError?.message ?? String(connectError));
        } finally {
          setBusy(false);
        }
      }, [sessionId, t]);

      const doSearch = useCallback(async () => {
        if (!sessionId || query.trim() === "") return;
        setBusy(true);
        setNote("");
        try {
          if (mode === "external") {
            const result = await callRemote(sessionId, "searchExternal", { query, limit: 10 });
            setCandidates(result.candidates);
            setFailures(result.failures ?? []);
            setHits(null);
            setPicked({});
          } else if (mode === "cnki") {
            const result = await callRemote(sessionId, "cnkiSearch", { query, limit: 20 });
            if (result.ok !== true) {
              setCandidates([]);
              setFailures([{ source: "cnki", reason: result.reason ?? "unavailable" }]);
              setError(null);
            } else {
              setCandidates(result.results.map((row) => ({
                title: row.title,
                authors: row.authors,
                year: (/(\d{4})/.exec(row.date ?? "") ?? [])[1] ?? "",
                venue: row.venue,
                doi: "",
                source: "cnki",
                href: row.href,
              })));
              setFailures([]);
              setError(null);
            }
            setHits(null);
            setPicked({});
          } else {
            const result = await callRemote(sessionId, "search", { query, limit: 30 });
            setHits(result.hits);
            setStatus(result.library);
            setCandidates(null);
            setFailures([]);
          }
          setError(null);
        } catch (searchError) {
          setError(searchError?.message ?? String(searchError));
        } finally {
          setBusy(false);
        }
      }, [sessionId, query, mode]);

      const addPicked = useCallback(async () => {
        if (!sessionId || !candidates) return;
        const chosen = candidates.filter((_candidate, index) => picked[index]);
        if (chosen.length === 0) return;
        setBusy(true);
        try {
          if (mode === "cnki") {
            // CNKI entries must be downloaded and indexed; a metadata-only row
            // for a paper whose PDF is right there would be a downgrade.
            let added = 0;
            const problems = [];
            for (const candidate of chosen) {
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
                if (result.ok === true && result.imported?.length > 0) added += 1;
                else problems.push(`${candidate.title}: ${result.reason ?? "下载失败"}`);
              } catch (downloadError) {
                problems.push(`${candidate.title}: ${downloadError?.message ?? String(downloadError)}`);
              }
            }
            setNote(`${t("added")} ${added}${problems.length > 0 ? ` · ${problems.length} 失败` : ""}`);
            if (problems.length > 0) setError(problems.slice(0, 3).join("; "));
            setPicked({});
            const state = await callRemote(sessionId, "status");
            setStatus(state.library);
          } else {
            const result = await callRemote(sessionId, "addCandidates", { candidates: chosen });
            setStatus(result.library);
            setNote(`${t("added")} ${result.imported.length}`);
            setPicked({});
            if (mode === "external") setCandidates(candidates.filter((_candidate, index) => !picked[index]));
          }
        } catch (addError) {
          setError(addError?.message ?? String(addError));
        } finally {
          setBusy(false);
        }
      }, [sessionId, candidates, picked, mode, t]);

      const doImport = useCallback(async (fileList) => {
        if (!sessionId || !fileList || fileList.length === 0) return;
        setBusy(true);
        setNote("");
        try {
          const files = [];
          for (const file of fileList) {
            const buffer = await file.arrayBuffer();
            files.push({ name: file.name, data: Array.from(new Uint8Array(buffer)) });
          }
          const result = await callRemote(sessionId, "importPdf", { files });
          setStatus(result.library);
          const okCount = result.imported.length;
          const failCount = result.failed.length;
          setNote(`✓ ${okCount}${failCount > 0 ? ` / ✗ ${failCount}` : ""}`);
          setHits(null);
          setError(failCount > 0 ? result.failed.map((f) => `${f.filename}: ${f.reason}`).join("; ") : null);
        } catch (importError) {
          setError(importError?.message ?? String(importError));
        } finally {
          setBusy(false);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }
      }, [sessionId]);

      const doDelete = useCallback(async (paperId) => {
        if (!sessionId) return;
        try {
          await callRemote(sessionId, "deletePaper", { paperId });
          setHits((current) => (current ? current.filter((hit) => hit.paperId !== paperId) : current));
          if (openPaper === paperId) setOpenPaper(null);
          refresh();
        } catch (deleteError) {
          setError(deleteError?.message ?? String(deleteError));
        }
      }, [sessionId, openPaper, refresh]);

      const askSelection = useCallback(async () => {
        if (!selection || !openPaper || !sessionId) return;
        const text = question.trim() === "" ? (t("askHint")) : question.trim();
        const composed = [
          `【论文】${openPaper}`,
          `【页码】第 ${selection.pageIndex + 1} 页`,
          `【引文】"${selection.text.slice(0, 600)}"`,
          `【问题】${text}`,
        ].join("\n");
        setQuestion("");
        const actions = inputActions;
        if (!actions) {
          setError("inputActions unavailable in this seat");
          return;
        }
        try {
          const span = actions.captureInsertion();
          actions.insertText({ ...span, text: composed });
          setNote("→ 已放入输入框，回车发送");
        } catch (askError) {
          setError(askError?.message ?? String(askError));
        }
      }, [selection, openPaper, question, inputActions, sessionId, t]);

      const saveEvidence = useCallback(async () => {
        if (!selection || !openPaper || !sessionId) return;
        try {
          const result = await callRemote(sessionId, "addEvidence", {
            paperId: openPaper,
            pageIndex: selection.pageIndex,
            quote: selection.text,
          });
          setNote(`${t("evidenceSaved")} #${String(result.evidenceId).slice(0, 8)}`);
        } catch (evidenceError) {
          setError(evidenceError?.message ?? String(evidenceError));
        }
      }, [selection, openPaper, sessionId, t]);

      const list = useMemo(() => hits ?? [], [hits]);

      return h("div", { style: styles.root, "data-paper-tool": "library" },
        h("div", { style: styles.row },
          h("strong", null, t("library")),
          status ? h("span", { style: styles.muted },
            `${status.papers} ${t("papers")} · ${status.pages} ${t("pagesLabel")}`) : null,
          h("span", { style: { flex: 1 } }),
          h("button", { type: "button", style: styles.button, onClick: refresh }, t("reload")),
        ),
        error ? h("p", { style: styles.error }, error) : null,
        note ? h("p", { style: styles.muted }, note) : null,

        h("div", { style: styles.row },
          h("input", {
            style: styles.input, value: query, placeholder: t("searchPlaceholder"),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") doSearch(); },
          }),
          h("button", { type: "button", style: styles.button, onClick: doSearch, disabled: busy || query.trim() === "" },
            busy ? (mode === "external" ? t("externalSearching") : t("searching")) : t("search")),
        ),

        h("div", { style: styles.row },
          h("button", {
            type: "button",
            style: { ...styles.button, ...(mode === "library" ? styles.active : null) },
            onClick: () => { setMode("library"); setCandidates(null); setFailures([]); },
          }, t("local")),
          h("button", {
            type: "button",
            style: { ...styles.button, ...(mode === "external" ? styles.active : null) },
            onClick: () => { setMode("external"); setHits(null); },
          }, t("external")),
          h("button", {
            type: "button",
            style: { ...styles.button, ...(mode === "cnki" ? styles.active : null) },
            onClick: () => { setMode("cnki"); setHits(null); },
          }, t("cnki")),
        ),

        failures.length > 0
          ? h("p", { style: styles.muted }, `${t("sourcesFailed")}: ${failures.map((f) => `${f.source} (${f.reason})`).join(", ")}`)
          : null,

        mode === "external" || mode === "cnki" ? h("div", { style: styles.row },
          h("span", { style: styles.muted },
            cnki === null
              ? t("cnki")
              : `${t("cnki")} · ${cnki.loggedIn ? t("cnkiConnected") : t("cnkiNotLoggedIn")}`),
          h("span", { style: { flex: 1 } }),
          h("button", {
            type: "button", style: styles.button, disabled: busy, onClick: connectCnki,
          }, cnki?.loggedIn ? t("cnkiRecheck") : t("cnkiConnect")),
        ) : null,

        h("div", { style: styles.row },
          h("button", {
            type: "button", style: styles.button, disabled: busy,
            onClick: () => fileInputRef.current?.click(),
          }, busy ? t("importing") : t("import")),
          h("input", {
            ref: fileInputRef, type: "file", accept: "application/pdf", multiple: true,
            style: { display: "none" },
            onChange: (event) => doImport(event.target.files),
          }),
        ),

        openPaper ? h(PdfReader, {
          sessionId, paperId: openPaper, t,
          onSelectionChange: setSelection,
          onClose: () => { setOpenPaper(null); setSelection(null); },
        }) : null,

        candidates !== null ? h("div", { style: styles.reader },
          h("div", { style: styles.row },
            h("strong", null, `${t("external")} · ${candidates.length}`),
            h("span", { style: { flex: 1 } }),
            h("button", {
              type: "button", style: styles.button,
              disabled: busy || !candidates.some((_candidate, index) => picked[index]),
              onClick: addPicked,
            }, t("addSelected")),
          ),
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
                  h("span", { style: styles.muted },
                    [candidate.year, candidate.venue, candidate.source, candidate.doi].filter(Boolean).join(" · ")),
                ),
              ),
            ))),
        ) : null,

        selection ? h("div", { style: styles.askBox },
          h("p", { style: styles.muted }, `${t("selected")} · ${t("page")} ${selection.pageIndex + 1} · ${selection.text.slice(0, 60)}…`),
          h("div", { style: styles.row },
            h("input", {
              style: styles.input, value: question, placeholder: t("askPlaceholder"),
              onChange: (event) => setQuestion(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") askSelection(); },
            }),
            h("button", { type: "button", style: styles.button, onClick: askSelection }, t("ask")),
            h("button", { type: "button", style: styles.button, onClick: saveEvidence }, t("evidence")),
          ),
        ) : null,

        hits === null
          ? (status && status.papers === 0 ? h("p", { style: styles.muted }, t("empty")) : null)
          : (list.length === 0
            ? h("p", { style: styles.muted }, t("noResults"))
            : h("ul", { style: styles.list },
              list.map((hit) => h(PaperCard, {
                key: `${hit.paperId}-${hit.pageIndex ?? "m"}`,
                hit: { ...hit, title: hit.title || hit.paperId },
                t,
                onOpen: setOpenPaper,
                onDelete: doDelete,
              })))),
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
      }, LibraryTabBody)), "paper-tool: tab body");
    }

    return {
      inject: ["locale", "slots", "sidebarRightTabs", "connection"],
      apply,
    };
  },
});

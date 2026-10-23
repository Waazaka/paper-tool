# @local/paper-tool

Local paper workbench for DSH: import PDFs, search full text, read in the
sidebar, build an evidence matrix, and generate traceable citations.

**No Zotero. No external software. No API keys.** Dependencies are
`pdfjs-dist` and `citeproc`, both vendored through pnpm.

## What it does

| Stage | Capability |
|---|---|
| Library | Import PDFs; text is extracted and indexed per page |
| Search | Chinese and English full-text search with page numbers and snippets |
| Reader | Right-sidebar PDF reader: page navigation, zoom, text selection |
| Evidence | Save a selection as an evidence row anchored to paper + page + offsets |
| Review | Evidence outline, claim × paper matrix (support / conflict / not found) |
| Citations | CSL rendering: APA, IEEE, MLA, Chicago, GB/T 7714 (numeric + author-date), Harvard, Nature |
| External | Search OpenAlex / Crossref / arXiv for new candidates |
| CNKI | One manual login, then automated search and PDF download |

## Install

The plugin is installed as a bundle in a DSH profile. It is already linked into
the `desktop` profile; restart DSH to activate it.

## Agent tools

Six tools, deliberately few: schema text is paid on every request, so related
operations share one tool.

| Tool | Purpose |
|---|---|
| `paper_search` | `scope=library` searches locally; `scope=external` queries OpenAlex/Crossref/arXiv; `scope=cnki` searches CNKI |
| `paper_import` | Save external candidates as metadata-only entries |
| `paper_read` | Read extracted page text with honest coverage reporting |
| `paper_evidence` | `action=collect` finds and stores passages; `action=list` lists them |
| `paper_review` | `action=outline` / `matrix` / `citations` |
| `paper_status` | Library coverage, evidence count, available styles |

## Honesty rules

These are invariants, not preferences:

- A paper with no text layer is stored as `material: "metadata"`, never as
  searchable full text.
- `paper_read` reports how many pages it actually returned.
- The evidence matrix reports `not_found` — a review that only shows agreement
  is not a review.
- Citations are rendered only from stored metadata. Nothing is invented.
- CNKI: the plugin never solves CAPTCHAs, never evades paywalls, never stores
  credentials. One human login, then automation.

## CNKI in detail

Direct HTTP to `kns.cnki.net` returns a 2146-byte 安全验证 page; this was
measured, not assumed. The slider CAPTCHA is not bypassed. Instead:

1. Click **连接知网** — Chrome opens with a dedicated profile
   (`%LOCALAPPDATA%\dsh-paper-tool\cnki-profile`).
2. Log in once through your institution's normal route.
3. The session cookie then lasts roughly 30 days; afterwards search, paginate,
   download and ingest are automated.

If CNKI presents a verification challenge, the plugin says so instead of
pretending it worked.

## Storage

| Path | Contents |
|---|---|
| `<workspace>/.dsh/paper-tool/library.sqlite` | Index: papers, pages, evidence, claims |
| `<workspace>/.dsh/paper-tool/files/` | Imported PDF bytes |
| `%LOCALAPPDATA%\dsh-paper-tool\cnki-profile` | CNKI browser session |

`node:sqlite` with FTS5 is used directly — no SQLite package. CJK queries route
to a `LIKE` scan because `unicode61` tokenizes whole Chinese runs as one token
and `trigram` needs three characters; `ponytail:` in `lib/store.js` marks that
ceiling.

## How the browser renders PDFs

The sidebar cannot `import` `pdfjs-dist` from node_modules: the client bundle
serves only registered modules. So the Host streams it instead:

1. `getPdfRuntime` sends `pdf.js` + `pdf.worker.mjs` source; the client turns
   them into Blob URLs and imports the module from there.
2. `GlobalWorkerOptions.workerSrc` points at the worker Blob. (Do not pass a
   `Worker` as `PDFWorker.create({ port })` — that field wants a `MessagePort`
   and throws.)
3. CMaps and standard fonts are fetched one file at a time through
   `getPdfAsset`. **Chinese PDFs render blank without their CMaps**, and a
   Blob-URL module has no base path for pdfjs to resolve `cmaps/` against, so
   the client subclasses `DOMBinaryDataFactory` and lets the Host serve the
   bytes. Asset names are validated against traversal before any file read.

## Tests

```powershell
cd packages\paper-tool
node test\s1-library.mjs   "$env:USERPROFILE\Zotero\storage"   # import + search
node test\s2-host.mjs      "$env:USERPROFILE\Zotero\storage"   # host service contract
node test\s3-evidence.mjs  "$env:USERPROFILE\Zotero\storage"   # evidence matrix + citations
node test\s4-tools.mjs     "$env:USERPROFILE\Zotero\storage"   # tool registration + external search
node test\s3-real-protocol.mjs "$env:USERPROFILE\Zotero\storage" # real protocol dependency
node test\wiring.mjs                                            # client RPC ↔ host methods
```

Any directory of PDFs works; the paths above are only a convenient corpus.
Each script prints `PASS` and exits 0, or lists failures and exits 1.

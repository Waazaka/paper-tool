# paper-tool

A literature workbench that lives in your editor sidebar. Import PDFs, search
them full-text in Chinese and English, read them, and turn what you read into a
traceable review — every quote carries its paper, page and character offsets all
the way into the exported Markdown.

Built as a plugin for [DSH](https://github.com/deepseek-ai). No Zotero. No
external software. No API keys.

[中文说明](README.zh-CN.md)

## The problem it solves

You can search a folder of PDFs with `grep`. What you cannot do is keep track of
*which* sentence on *which* page of *which* paper supports *which* claim — and
that is the actual work of writing a literature review. This plugin makes that
linkage the primary data structure instead of something you retype into a notes
file and lose.

Concretely:

- A search result is a **page**, not a file. You get the page number and a
  snippet, not a 40-page PDF to scroll through.
- Saved evidence is anchored to **paper + page + character offsets**, so it
  survives being moved into a Markdown file or a different view.
- The review export tells you **how many quotes it could anchor and how many it
  had to drop**, rather than silently shipping a citation that points nowhere.

## What it does

| Stage | Capability |
|---|---|
| Library | Import PDFs; text is extracted and indexed per page |
| Library | **Scanned PDFs (no text layer) are OCR'd on import and become searchable** |
| Search | Chinese and English full-text search with page numbers and snippets |
| Library | Browse imported papers without searching; edit metadata; delete with confirmation |
| Reader | PDF canvas + selectable text layer: page jump, navigation, zoom, fit-width |
| Evidence | Save a selection (or collect by topic) anchored to paper + page + offsets |
| Review | Evidence outline, claim × paper matrix (support / conflict / not found / no evidence) |
| Citations | CSL rendering: APA, IEEE, MLA, Chicago, GB/T 7714 (numeric + author-date) |
| Export | Writes `review.md` + `references.bib` with anchor checks |
| External | Search OpenAlex / Crossref / arXiv for new candidates |
| CNKI | One manual login, then automated search and PDF download |

The sidebar has three views: **文献库** (library), **证据** (evidence),
**综述** (review). The reader keeps the PDF text layer over the canvas; when that
layer cannot be created, it falls back to a selectable text panel instead of
silently disabling selection.

## Requirements

- **DSH** desktop app (the plugin host). The package is a DSH client+host bundle.
- **Windows** for the OCR path only. Everything else is cross-platform. OCR uses
  `Windows.Media.Ocr`, which ships with the OS — that is why there is nothing to
  install, and also why OCR is unavailable on macOS and Linux.
- **Node 22+** to run the gates (they use `node:sqlite` and `node:test`).

Dependencies are deliberately three: `pdfjs-dist` (render + text extraction),
`citeproc` (citation formatting), `@napi-rs/canvas` (page rasterisation for OCR).


## OCR for scanned PDFs

A PDF with no text layer used to be stored as metadata-only — present in the
library, impossible to search or quote. `importPdf` now detects that case, renders
each page with pdf.js, and recognises it with `Windows.Media.Ocr`.

Three states are stored, not two, because they are not the same promise:

| `material` | `textSource` | Meaning |
|---|---|---|
| `fulltext` | `text-layer` | Text came from the PDF's own text layer |
| `ocr` | `ocr` | Text was recognised from page images — **characters may be wrong** |
| `metadata` | `text-layer` | No text at all; only bibliographic fields exist |

The distinction is carried all the way out: the library badge, the evidence row,
every quote in the exported `review.md` (marked `（OCR）`), and the text the model
receives from `paper_read` all say when a quote was guessed rather than read.

Known limits, stated rather than hidden:

- **Windows only.** The engine is `Windows.Media.Ocr`; on other platforms OCR is
  reported unavailable and the paper stays metadata-only. Nothing else breaks.
- **40 pages per import.** Recognition costs about a second per page and runs
  inside the import. A longer scan is refused with a stated reason instead of
  timing out halfway.
- **No layout reconstruction.** Tables, formulas and multi-column text come back
  as a single stream. This is a limitation of OCR, not a bug to be fixed here.
- **No spell correction.** Misread characters are kept as recognised. Silently
  "fixing" them would turn a quote into an invention.
- **An unreadable page yields nothing, not a guess.** A pure-noise image returns
  no text; the paper is still marked `ocr` so the user knows to check the page.

Measured on this machine with `zh-Hans-CN`: a clean Chinese scan came back almost
exactly (one glyph misread: 「济」→「冫齐」), a faint scan was correct, a heavily
blurred scan degraded to `庶游贡虱诟关究`, and a noise-only image returned no text
at all. CJK glyphs are emitted one per token (`旅 游 经 济`) and are de-spaced
before storage, otherwise Chinese search would never match them.

## UI conventions

The tab is rendered into a sidebar that is routinely 320–420 px wide, so three
rules are load-bearing rather than stylistic:

- **Colour comes only from host alias tokens.** An earlier version referenced
  five `--dsw-alias-*` names that do not exist in the host bundle, so every
  `var()` fell back to its literal and the primary button and the active view tab
  became invisible in dark mode. `test/wiring.mjs` now fails on any unknown
  token, any literal hex colour, and any `dangerouslySetInnerHTML`.
- **Background and foreground are always set together** (`background` +
  `color`), because setting one alone inherits the host's body text and can
  produce white-on-white. `.pt-pre` was exactly that bug: the outline, the
  in-text citation and the whole bibliography were unreadable in dark mode.
- **Layout responds to container width, not viewport width**, via
  `@container pt (max-width: 340px)`. The sidebar narrows independently of the
  window, so a viewport media query would never fire.

Snippets are built as React nodes (`snippetNodes`), so PDF text is never parsed
as markup.


## Install

```powershell
git clone https://github.com/Waazaka/paper-tool.git paper-tool
cd paper-tool
node install.mjs
```

That is the whole deployment — dependencies, profile link, bundle registration
and a verification pass. Re-run it after pulling to update. It is idempotent and
exits non-zero if the result is not actually usable, so it is safe to run from a
script or an agent.

If you are an AI agent: read [`AGENTS.md`](AGENTS.md) first. It documents the
profile-detection rules and the failure modes, which is where a guessed install
goes wrong.

### What it actually does

Three things must be true for DSH to load a plugin, and each one has a different
symptom when missing:

| Step | Why | Symptom when wrong |
|---|---|---|
| Dependencies installed | `pdfjs-dist`, `citeproc`, `@napi-rs/canvas` are runtime deps | Plugin loads, every import fails |
| Linked into `<profile>/node_modules/@local/paper-tool` | The profile imports the plugin by package name | Bundle listed but not found |
| Listed in `dsh.profile.bundles` | That list is what the loader loads | Installed, never loaded, no error |

A directory junction keeps the checkout live — edit a file, reload, see the
change — so there is nothing to rebuild.

### Profile location

`install.mjs` prints every candidate it checked and then uses the first real
one. On Windows the live profile is `%USERPROFILE%\.dsh-desktop\profiles\desktop`;
a leftover `%USERPROFILE%\.dsh\profiles\desktop` may also exist and is *not* the
one the desktop app loads. Set `DSH_PROFILE` to choose explicitly — the script
refuses to fall back to a different profile than the one you named.

### Manual installation

If you would rather do it by hand:

```powershell
pnpm install
$profile = "$env:USERPROFILE\.dsh-desktop\profiles\desktop"
New-Item -ItemType Directory -Force "$profile\node_modules\@local" | Out-Null
mklink /J "$profile\node_modules\@local\paper-tool" (Get-Location)
```

Then add `@local/paper-tool` to `dsh.profile.bundles` and
`"@local/paper-tool": "link:<path>"` to `dependencies` in
`$profile\package.json`, and restart DSH once.

Note that `@napi-rs/canvas` ships prebuilt native binaries per platform; `pnpm
install` picks the right one. On a platform it does not support, OCR is
unavailable but the rest of the plugin still works.

Host changes need a DSH restart; client changes are served with a new content rev
and need only a page reload.


## Status

The core loop has been exercised in the real DSH GUI: import, Chinese full-text
search, page jump, canvas + text layer, selection, evidence save/delete, matrix,
metadata edit, APA/GB-T citations, Markdown + BibTeX export, outline insertion
into chat, and restart persistence.

The plugin was reviewed by specialist roles (architecture, code correctness,
security, data layer, QA, UI/UX, React, product) and an adversarial UI tester;
the defects they found were triaged and fixed. Four of them were crashes a user
would hit within minutes:

| Defect | Cause |
|---|---|
| Blank sidebar after switching tabs | No React error boundary anywhere in the tree |
| `doc.destroy is not a function` on closing the reader | PDF.js 6 moved `destroy` from the document to the loading task |
| `null` handed to `page.render()` | `canvas.getContext("2d")` can fail (GPU restart, context exhaustion) |
| Chinese search silently empty | A leftover `DROP TABLE` in a migration deleted the trigram index |

Known gaps, stated rather than hidden:

- **CNKI needs one manual login** and was not re-tested live.
- **PDF metadata guesses are approximate.** Title/venue/year come from XMP, then
  the PDF Info dictionary, then the page-1 type size. A misread value is worse
  than an empty one, so the extractor now prefers emptiness; fields it filled by
  inference are flagged **待核对** (unverified) in the UI. Correct them with
  **编辑元数据** before citing.
- **Text input is not covered by the gates.** The DOM stub cannot currently
  deliver keystrokes to React's `onChange`; a tracked defect, not a silent pass.


## Agent tools

Six tools, deliberately few: schema text is paid on every request, so related
operations share one tool.

| Tool | Purpose |
|---|---|
| `paper_search` | `scope=library` searches locally; `scope=external` queries OpenAlex/Crossref/arXiv; `scope=cnki` searches CNKI |
| `paper_import` | Save external candidates as metadata-only entries |
| `paper_read` | Read extracted page text with honest coverage reporting |
| `paper_evidence` | `action=collect` finds and stores passages; `action=list` lists them |
| `paper_review` | `action=outline` / `matrix` / `citations` / `export` |
| `paper_status` | Library coverage, evidence count, available styles |

## Honesty rules

These are invariants, not preferences:

- A paper with no text layer is stored as `material: "metadata"`, never as
  searchable full text.
- `paper_read` reports how many pages it actually returned, plus a required
  `truncated` flag, so a truncated read cannot look complete.
- The evidence matrix reports `not_found` (the paper was searched and does not
  mention the claim) separately from `no_evidence` (the paper has no stored
  evidence at all). A review that only shows agreement is not a review.
- Evidence records `charStart` / `charEnd` only when the quote was located in
  the stored page text; otherwise both are `-1` and the UI labels it
  **仅记录页码**. Export uses located evidence only, and says how many rows it
  excluded.
- Re-importing the same PDF is reported as `duplicates`, never as `imported`.
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
| `%DSH_HOME%\paper-tool\library.sqlite` | Index: papers, pages, evidence, claims |
| `%DSH_HOME%\paper-tool\files\` | Imported PDF bytes |
| `%LOCALAPPDATA%\dsh-paper-tool\cnki-profile` | CNKI browser session |

`DSH_HOME` is the DSH profile directory (`~/.dsh-desktop` on Windows). One
library, shared by every workspace: a research library is personal and
cross-project, and a per-workspace database made papers imported in one folder
invisible from the next, which reads as data loss. A library that already
exists at the old `<workspace>/.dsh/paper-tool/library.sqlite` location is copied
into the shared one on first start, but only when no shared library exists yet,
so it can never overwrite newer data.

Set `dbPath` in the plugin config to point at a specific file, or `shared: false`
to restore one library per workspace.

`node:sqlite` with FTS5 is used directly — no SQLite package. Two indexes, because
one tokenizer cannot serve both scripts:

| Index | Tokenizer | Serves |
|---|---|---|
| `pages_fts` | `unicode61` | Latin words |
| `pages_cjk` | `trigram` | Chinese, any substring of ≥3 characters |

`unicode61` treats a whole Chinese run as a single token, so it cannot match a
substring of it; `trigram` can, but needs at least three characters. Queries of
one or two CJK characters therefore fall back to a `LIKE` scan, which is correct
but slower — measured at 10 ms for 2 400 pages, and still the right trade at that
size. At 24 000 pages the index wins decisively: a rare term is ~1848× faster
through `MATCH` than through `LIKE`.

Schema is versioned with `PRAGMA user_version` and migrates forward only
(`SCHEMA_VERSION = 5`). Every migration runs automatically and idempotently at
open, so an existing library is upgraded in place:

| Version | Change |
|---|---|
| v2 | explicit evidence offsets (`charStart` / `charEnd`) |
| v3 | `metadataSource` — which channel supplied each field |
| v4 | `claims` table |
| v5 | `pages_cjk` trigram index restored, with backfill |

> v2 originally also dropped `pages_cjk` to halve page-write cost. When v5
> brought CJK search back, that leftover `DROP TABLE` deleted the index the new
> schema had just created — Chinese search returned nothing. The gate now asserts
> the table exists and that both insert and delete triggers keep it in sync.

Search results are capped per paper (`ROW_NUMBER() OVER (PARTITION BY paperId)`,
at most `min(cap, 20)` pages each) so a single long paper cannot fill the result
list for a common term. The CJK path does this in two passes — rank first, then
fetch text only for the surviving rows — because joining `text` into the
windowed query made SQLite materialise every matching row: 272 ms became 76 ms.


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

One command runs everything:

```powershell
node test\all.mjs "$env:USERPROFILE\Zotero\storage"
```

Pass any directory of PDFs as the argument; point it at your own library. It
prints one line per gate and exits 0 only when all pass. A gate that needs a PDF
corpus is **skipped** (and labelled as such) when no corpus is present — a skip
is not a pass.

| Gate | What it verifies |
|---|---|
| `s1-library` | import, per-page storage, Chinese + English search |
| `s2-host` | host service contract and error shapes |
| `s3-evidence` | evidence anchoring, matrix, CSL citations |
| `s4-tools` | tool registration and external search |
| `s5-export` | metadata editing and the export bundle |
| `s3-real-protocol` | behaviour against the real typert protocol |
| `s6-ocr` | scanned PDF → searchable text; degraded scans; oversized renders |
| `s7-functional` | the whole workflow on real PDFs from the corpus |
| `s9-metadata` | title/authors/venue/year extraction on real papers |
| `s10-anchoring` | quote offsets survive whitespace changes |
| `s11-search` | CJK segmentation, AND semantics, trigram index sync |
| `wiring` | client RPC ↔ host methods; theme tokens; no literal colours or raw HTML |
| `ui-render` | every view renders; dictionaries agree; badge states differ |
| `s8-ui-a11y` | accessible names, tab state, and honesty of coverage claims |
| `s11-interaction` | mount the real pane, click through tabs, survive rapid cycling |
| `s12-reader-lifecycle` | reader mount/unmount, rapid paging, document release |
| `s13-resilience` | a view that throws keeps the pane alive and recoverable |
| `s14-pdf-api` | the teardown API actually matches the installed PDF.js |
| `s15-teardown` | which unmount paths catch a throw, and which do not |

Individual gates still run standalone, e.g. `node test\s6-ocr.mjs`.

### Two things worth knowing about this suite

**The UI gates mount the real component tree.** `react-dom/server` never runs
`useEffect`, so an effect-time crash is invisible to it. `s11`–`s13` use
`react-dom/client` against a hand-written DOM stub, which is how the blank-pane
defect was finally reproduced.

**`s14` reads the installed `pdfjs-dist`, it does not trust a stub.** An earlier
gate asserted `doc.destroy()` was called because its fake PDF.js *had* that
method. The real PDF.js 6 does not — so the gate was green while every real
close crashed. `s14` now asserts against the actual package, and
`node test\prove-s14.mjs` reverts the fix in memory and asserts the gate fails,
because a gate that cannot fail is not a gate.


`wiring.mjs`, `ui-render.mjs`, `s8-ui-a11y.mjs` and `all.mjs` must be run from
`packages\paper-tool` because they read the client and host sources by relative
path.

`wiring.mjs` checks more than the RPC names: it verifies the RPC markers through
the real `@deepseek-ai/dsh-typert-protocol` `remoteMethods()` rather than by
matching source strings (a shim that stubbed `Remote()` as a no-op used to make
this read zero and validate nothing), and it fails on a `--dsw-alias-*` token the
installed host bundle does not define, on a literal hex colour in `client.js`, and
on any `dangerouslySetInnerHTML`.

`ui-render.mjs` renders each view through `react-dom/server` with a stand-in
module loader. It catches a class of defect the Host tests cannot see: a view
that throws the first time a user opens it, or a translation key missing from one
dictionary. It also runs `apply()` against a fake ctx to assert the tab type, tab
body, dictionaries, `keepMounted`, and that the tab title goes through `t()`
rather than a hardcoded string. Note that it resolves `react` from `react-dom`'s
own directory — the desktop profile deliberately combines React 18 (for host
bundles) with a `react-dom` junction into a 19.x tree, and mixing the two throws a
misleading "Objects are not valid as a React child".

`s6-ocr` proves its own validity first: it asserts the fixture PDF yields **zero**
extractable characters, so OCR is the only possible source of the text it then
checks. Without that assertion the test could pass while never invoking OCR.

`s7-functional` runs on whatever real papers the corpus contains. Its core check
re-derives a stored quote from its saved `charStart`/`charEnd` — that is the
machine-checkable form of "clicking an evidence jumps back to the quote".

`s8-ui-a11y` covers what is statically checkable and still user-visible: that
icon buttons have accessible names, tabs are real buttons with `aria-selected`,
every `<button>` sets `type="button"`, OCR text is never folded into "full text"
or "metadata only", and a `-1` "unlocated" evidence is never presented as
located. It exists because the interaction tier (`s11`–`s13`) has a real DOM but
no accessibility tree, so the two tiers check different halves of the same
promise.

Dictionary keys are looked up **flat** by the host locale service, so dotted names
such as `guide.description` must be literal keys, never nested objects.

Any directory of PDFs works; the paths above are only a convenient corpus.
Each script prints `PASS` and exits 0, or lists failures and exits 1.

> **Sandbox note.** Under the harness sandbox a child process may not write to an
> inherited pipe (`spawn` capture fails with `EPERM`) and recursive removal of a
> temp directory is denied. Gates therefore exchange verdicts through the file
> named by `PAPER_TOOL_RESULT_FILE` (set by `all.mjs`) instead of stdout, and
> leave scratch databases in `test/.scratch/` (git-ignored) rather than deleting
> them.

## What is not tested

Being explicit about this matters more than the gate count:

- **Typing.** The DOM stub cannot deliver keystrokes to React's `onChange`. A
  focused investigation found three separate stub defects and fixed two of them,
  then established that React's change plugin never even queries the value tracker
  (zero calls, measured). `test/s16-typing.mjs` is that investigation, kept as a
  runnable script. It is **deliberately not registered in `test/all.mjs`** while it
  fails, so the suite stays green for reasons it can actually defend — but that
  also means the suite does not cover typing, and until it does, treat "the search
  box works" as **unverified by this suite**.
- **Rendered pixels.** The gates prove the render path executes and does not
  throw. They cannot prove the page looks right.
- **A real browser.** Headless Chrome is blocked in the development sandbox
  (crashpad access denied), so every UI assertion here runs against a hand-written
  DOM, not Chromium.


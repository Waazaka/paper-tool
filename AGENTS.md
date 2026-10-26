# AGENTS.md

Instructions for an AI agent asked to install, update or debug this plugin in
DSH. Written to be followed without reading the rest of the repository.

This file lives with the plugin package. In the full repository the plugin is at
`packages/paper-tool/`, so run every command below from that directory; when the
package is cloned on its own it is the repository root.

## One command

```powershell
node install.mjs
```

That is the whole deployment. It installs runtime dependencies if missing, links
the package into the DSH profile, registers it as a bundle, then verifies the
result and exits `0` only if the plugin is actually usable. Exit `1` means it
failed and printed why; nothing is silently half-installed.

Run it again after pulling changes. It is idempotent: an already-correct install
is left alone, and it prints what it found and what it changed.

## What it does, and why each step is needed

DSH loads plugins from a *profile*. Getting three things right is what makes the
plugin appear; missing any one of them produces a different confusing symptom.

| Step | Why it matters | Symptom when wrong |
|---|---|---|
| `pnpm install` | `pdfjs-dist`, `citeproc` and `@napi-rs/canvas` are real runtime dependencies | Plugin loads, every import fails |
| Link into `<profile>/node_modules/@local/paper-tool` | The profile imports the plugin by package name | Bundle listed but not found |
| Add to `dsh.profile.bundles` in the profile's `package.json` | This list is what the loader actually loads | Installed, never loaded, no error |

## Locating the profile (the step agents get wrong)

`install.mjs` detects it and prints every candidate it checked. Do not guess:

- `%DSH_PROFILE%` — if set, it wins and **must** be a real profile. The script
  refuses to fall back to another one, because deploying into a profile the
  caller did not name is worse than failing.
- `%DSH_HOME%\profiles\desktop`
- `%USERPROFILE%\.dsh-desktop\profiles\desktop` — the desktop app's profile on
  Windows. This is the live one in a desktop install.
- `%USERPROFILE%\.dsh\profiles\desktop` — often a leftover from an older
  install. Used only when nothing else exists.

A machine can have both `.dsh` and `.dsh-desktop` with different contents.
Deploying into the unused one installs the plugin where nothing reads it.

## Verifying it worked

The script already checks the things that can be checked without a browser. To
confirm by hand:

```powershell
# the profile must resolve the package name to this checkout
(Get-Item "$env:USERPROFILE\.dsh-desktop\profiles\desktop\node_modules\@local\paper-tool").Target

# and must list it as a bundle
Select-String -Path "$env:USERPROFILE\.dsh-desktop\profiles\desktop\package.json" -Pattern 'paper-tool'
```

In the GUI: the **论文 / Papers** tab appears in the right sidebar and opens
itself on first use. Host tools (`paper_search`, `paper_import`, `paper_evidence`,
`paper_review`, `paper_status`, …) become available to the agent.

## Restart rules

- **Host half** (`index.js`, `lib/**`) — needs a full DSH restart.
- **Client half** (`client.js`) — served with a new content revision; a page
  reload is enough.

An agent that changed both must say "restart DSH", not "refresh the page".

## If something is wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| "1 entry did not activate" | A service the plugin injects is missing from this DSH build | The right column is already gated behind a child fiber; check the log for the missing name |
| Tab never appears | Bundle registered but the profile link is missing | Re-run `node install.mjs`, read the verification output |
| Plugin listed, nothing loads | Deployed into `~/.dsh` while the app uses `~/.dsh-desktop` | Re-run with `DSH_PROFILE` pointing at the live profile |
| Every import fails | `node_modules` absent in the plugin checkout | `pnpm install`, or re-run `install.mjs` |
| Papers look missing after an upgrade | The library moved from per-workspace to per-profile | See the Storage section of `README.md`; the old database is copied automatically on first start |

## Data locations

The library is shared by all workspaces, not per project:

- `%DSH_HOME%\paper-tool\library.sqlite` — index (papers, pages, evidence, claims)
- `%DSH_HOME%\paper-tool\files\` — imported PDF bytes

An older `<workspace>/.dsh/paper-tool/library.sqlite` is copied into the shared
location on first start, but only when no shared library exists, so it can never
overwrite newer data.

## Tests

```powershell
node test/all.mjs "$env:USERPROFILE\Zotero\storage"
```

Exit `0` and `20 passed, 0 failed` means the contract holds. The corpus argument
is optional; gates that need real PDFs are reported as skipped, never silently
passed.

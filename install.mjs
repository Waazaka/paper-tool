#!/usr/bin/env node
// One-command deployment into a DSH profile.
//
//   node install.mjs
//
// Written to be run by an agent as much as by a person, which shapes the rules:
//
//   * Say what it found before acting. An agent that has to guess the profile
//     location will guess wrong: this machine has both `%USERPROFILE%\.dsh` and
//     `%USERPROFILE%\.dsh-desktop`, and only the second is what the desktop app
//     loads.
//   * Be idempotent. Running it twice must not duplicate registration or fail.
//   * Never invent a location. If no profile is found, list what was checked and
//     stop, rather than creating a plausible-looking directory.
//   * Verify at the end. A silent "done" that leaves the plugin unloaded is the
//     worst possible outcome, so the result is checked and the exit code says so.
//
// Exit codes: 0 deployed and verified, 1 failed, 2 deployed but DSH must restart.
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = "@local/paper-tool";
const PKG = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const VERSION = PKG.version;

/**
 * Read a JSON file the way DSH will, minus the BOM.
 *
 * A UTF-8 BOM makes `JSON.parse` throw `Unexpected token`. Some editors (and
 * PowerShell's own `Set-Content -Encoding utf8`) write one, so a profile edited
 * by a human or another tool can legally carry it. The BOM is stripped before
 * parsing but the file is written back without one, which repairs it.
 */
function readJson(path) {
  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const say = (message) => console.log(message);
const step = (message) => console.log(`\n== ${message}`);
const warn = (message) => console.warn(`warning: ${message}`);
const samePath = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

function fail(message, code = 1) {
  console.error(`\nFAILED: ${message}`);
  process.exit(code);
}

// --- 1. locate the profile ------------------------------------------------
//
// Order matters. `DSH_PROFILE` and `DSH_HOME` are explicit intents. Then the
// desktop profile, which is what the app's `--user-data-dir` resolves to on
// Windows. The plain `~/.dsh` directory is checked last and only used if nothing
// else exists: it is often a leftover from an older install, and deploying into
// it yields a plugin that is installed but never loaded — the exact confusing
// failure this script exists to prevent.
step("Locating the DSH profile");
const home = homedir();

// An explicitly named profile that does not exist is an error, never a hint to
// try somewhere else. Falling back would deploy into a profile the caller did not
// name while still reporting success — the link and the bundle registration would
// land in the wrong place. This is not hypothetical: an earlier version of this
// script was pointed at a non-existent profile during testing, silently deployed
// into the real one, and repointed the user's own development checkout.
for (const explicit of ["DSH_PROFILE", "DSH_HOME"]) {
  const value = process.env[explicit];
  if (!value) continue;
  const asProfile = explicit === "DSH_PROFILE" ? resolve(value) : join(value, "profiles", "desktop");
  if (!existsSync(join(asProfile, "package.json"))) {
    fail(
      `${explicit} is set to ${value}, but ${asProfile} is not an initialised DSH profile ` +
        "(no package.json). Refusing to deploy into a different profile. " +
        "Point it at one, or unset it to auto-detect.",
    );
  }
}

const candidates = [];
if (process.env.DSH_PROFILE) candidates.push({ path: resolve(process.env.DSH_PROFILE), why: "DSH_PROFILE" });
if (process.env.DSH_HOME) candidates.push({ path: join(process.env.DSH_HOME, "profiles", "desktop"), why: "DSH_HOME" });
candidates.push({ path: join(home, ".dsh-desktop", "profiles", "desktop"), why: "~/.dsh-desktop" });
candidates.push({ path: join(home, ".dsh", "profiles", "desktop"), why: "~/.dsh (legacy)" });

let profile = null;
const seen = new Set();
for (const candidate of candidates) {
  if (seen.has(candidate.path)) continue;
  seen.add(candidate.path);
  const hasPackage = existsSync(join(candidate.path, "package.json"));
  say(`  ${hasPackage ? "found  " : "missing"} ${candidate.path}  (${candidate.why})`);
  // A directory without package.json is not an initialised profile, so it is
  // skipped rather than half-created.
  if (hasPackage && profile === null) profile = candidate.path;
}
if (profile === null) {
  fail(
    "no DSH profile found. Checked:\n" +
      candidates.map((c) => `  - ${c.path}`).join("\n") +
      "\nStart DSH once so it creates its profile, or pass DSH_PROFILE=<dir>.",
  );
}
say(`  using: ${profile}`);

// --- 2. install runtime dependencies -------------------------------------
//
// `pdfjs-dist`, `citeproc` and `@napi-rs/canvas` are real runtime dependencies:
// text extraction, citation formatting and page rasterisation for OCR. Without
// them the plugin loads and then fails on every import, so this is verified
// rather than assumed — a fresh clone has no node_modules.
step("Checking runtime dependencies");
const REQUIRED_DEPS = ["pdfjs-dist", "citeproc", "@napi-rs/canvas"];
const depPath = (name) => join(HERE, "node_modules", ...name.split("/"));
const missingDeps = REQUIRED_DEPS.filter((name) => !existsSync(depPath(name)));

if (missingDeps.length === 0) {
  say(`  all present (${REQUIRED_DEPS.join(", ")})`);
} else {
  say(`  missing: ${missingDeps.join(", ")}`);
  // Prefer the pnpm that ships with DSH, since an agent has no reliable PATH;
  // fall back to a system pnpm.
  const desktopRoot = join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "runtime");
  const bundledPnpm = join(desktopRoot, "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs");
  const bundledNode = join(desktopRoot, "primary-runtime", "dependencies", "node", "bin", "node.exe");

  let result = null;
  if (existsSync(bundledPnpm)) {
    const node = existsSync(bundledNode) ? bundledNode : process.execPath;
    say("  installing with the pnpm bundled with DSH…");
    result = spawnSync(node, [bundledPnpm, "install"], { cwd: HERE, stdio: "inherit" });
  }
  if (result === null || result.status !== 0) {
    say("  installing with pnpm from PATH…");
    result = spawnSync("pnpm", ["install"], { cwd: HERE, stdio: "inherit", shell: true });
  }
  if (result === null || result.status !== 0) {
    fail(
      "could not install dependencies. Run `pnpm install` in this directory, then try again. " +
        `Still missing: ${missingDeps.join(", ")}`,
    );
  }
  const stillMissing = REQUIRED_DEPS.filter((name) => !existsSync(depPath(name)));
  if (stillMissing.length > 0) fail(`pnpm finished but these are still missing: ${stillMissing.join(", ")}`);
  say("  installed");
}

// --- 3. link the package into the profile --------------------------------
//
// The plugin must be importable as `@local/paper-tool` from inside the profile,
// so the profile needs `node_modules/@local/paper-tool` pointing here. A junction
// keeps the checkout live: edit a file, reload, see the change. Copying would
// freeze a stale snapshot and silently diverge from the repository.
step("Linking the package into the profile");
const scopeDir = join(profile, "node_modules", "@local");
const linkPath = join(scopeDir, "paper-tool");
mkdirSync(scopeDir, { recursive: true });

if (existsSync(linkPath) && samePath(linkPath, HERE)) {
  say(`  already linked to this checkout`);
} else {
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    say(`  replacing the existing entry (${stat.isSymbolicLink() ? "symlink" : "directory"})`);
    try {
      // Unlink a junction/symlink; a real directory is moved aside instead of
      // deleted, so a previous copy-based install is never destroyed.
      rmSync(linkPath, { force: true, recursive: false });
    } catch {
      const aside = `${linkPath}.old-${Date.now()}`;
      renameSync(linkPath, aside);
      warn(`could not remove the old entry; moved it to ${aside}`);
    }
  }
  const created =
    process.platform === "win32"
      ? spawnSync("cmd", ["/c", "mklink", "/J", linkPath, HERE], { stdio: "pipe" })
      : spawnSync("ln", ["-sfn", HERE, linkPath], { stdio: "pipe" });
  if (created.status !== 0) {
    fail(
      `could not create the link:\n  ${linkPath}\n  -> ${HERE}\n` +
        (created.stderr?.toString().trim() || "") +
        "\nCreate it manually with:\n" +
        `  mklink /J "${linkPath}" "${HERE}"`,
    );
  }
  if (!samePath(linkPath, HERE)) fail(`the link was created but does not resolve to ${HERE}`);
  say(`  linked ${linkPath} -> ${HERE}`);
}

// --- 4. register the bundle in the profile -------------------------------
//
// DSH loads a profile's plugins from `dsh.profile.bundles` in the profile's own
// package.json, and resolves each name against the profile's node_modules. Both
// halves are required: linking alone leaves the plugin invisible, and listing a
// bundle that cannot be resolved makes the profile fail to load.
step("Registering the bundle in the profile");
const profilePkgPath = join(profile, "package.json");
let profilePkg;
try {
  profilePkg = readJson(profilePkgPath);
} catch (error) {
  // The link is already in place, so say what exists instead of leaving the next
  // reader to work out how far the run got.
  fail(
    `the profile's package.json could not be parsed: ${error.message}\n` +
      `  ${profilePkgPath}\n` +
      `The link ${linkPath} was created; the bundle is NOT registered yet.\n` +
      "Fix that file by hand and re-run this script (it is safe to repeat).",
  );
}

profilePkg.dependencies ??= {};
profilePkg.dsh ??= {};
profilePkg.dsh.profile ??= {};
profilePkg.dsh.profile.bundles ??= [];

const previousSpec = profilePkg.dependencies[PACKAGE_NAME];
const linkSpec = `link:${HERE.replace(/\\/g, "/")}`;
const alreadyDep = previousSpec !== undefined;
const alreadyBundle = profilePkg.dsh.profile.bundles.includes(PACKAGE_NAME);

if (alreadyDep && previousSpec === linkSpec) {
  say(`  dependency already points here`);
} else {
  profilePkg.dependencies[PACKAGE_NAME] = linkSpec;
  say(`  dependency ${PACKAGE_NAME}: ${previousSpec ?? "(none)"} -> ${linkSpec}`);
}
if (alreadyBundle) {
  say("  bundle already listed");
} else {
  profilePkg.dsh.profile.bundles.push(PACKAGE_NAME);
  say(`  bundle list += ${PACKAGE_NAME}`);
}
if (!alreadyDep || previousSpec !== linkSpec || !alreadyBundle) {
  // Written as UTF-8 without a BOM: this file is parsed by DSH, and a BOM has
  // broken JSON.parse in this project before.
  writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`, "utf8");
  say("  profile package.json updated");
} else {
  say("  nothing to change");
}

// --- 5. verify -----------------------------------------------------------
//
// Everything above is a claim; this is the check. The plugin only counts as
// deployed when the profile resolves the package name to this checkout and lists
// it as a bundle.
step("Verifying the deployment");
const problems = [];

const verifyPkg = readJson(profilePkgPath);
if (!verifyPkg.dsh?.profile?.bundles?.includes(PACKAGE_NAME)) {
  problems.push(`profile package.json does not list ${PACKAGE_NAME} in dsh.profile.bundles`);
}
if (!existsSync(linkPath)) {
  problems.push(`the profile has no node_modules entry at ${linkPath}`);
} else if (!samePath(linkPath, HERE)) {
  problems.push(`${linkPath} does not resolve to ${HERE}`);
}
// Entry points the loader reads. A missing host entry fails at load time with an
// import error that points nowhere near the real cause.
for (const entry of ["index.js", "client.js", "cordis.patch.yml"]) {
  if (!existsSync(join(HERE, entry))) problems.push(`package file missing: ${entry}`);
}
if (problems.length > 0) {
  fail(`deployment is not usable:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}
say("  profile resolves the package to this checkout");
say("  bundle is registered");

// --- 6. what happens next ------------------------------------------------
//
// Host-side changes (index.js, lib/**) are only picked up when DSH restarts; the
// client half is served with a new content rev and needs just a page reload. An
// agent cannot tell which kind of change it made, so both are stated.
say("\nDeployed " + PACKAGE_NAME + " " + VERSION + ".");
say("Restart DSH to load the host half, then open the paper panel in the right sidebar.");
say("(Client-only changes need just a page refresh.)");
process.exit(0);

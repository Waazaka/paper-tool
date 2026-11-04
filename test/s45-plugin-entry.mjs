// Gate: how each half of the plugin reaches the running DSH, so "restart or reload?"
// is answered from the manifest instead of from memory.
//
// This matters because the two answers are not interchangeable. The host half is loaded
// by Node from index.js; the client half is served to the browser from ./client.js. Get
// it wrong and a fix appears not to work: tell the user to reload when the host changed
// and nothing happens, or ask for a restart when a reload was enough.
//
// It also pins the fact that this plugin has NO build step. There is no prepare,
// prepublish or prebuild script, and `exports["./client"]` points straight at the
// source file. That is what makes a client change live on reload — and it is worth
// asserting, because adding a build step later would silently make every client fix
// require a build that nobody runs, with no error anywhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else { console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail)); failures.push(name); }
}

// --- the host half -----------------------------------------------------
check("the package declares a host entry", typeof pkg.exports?.["."] === "string", JSON.stringify(pkg.exports?.["."]));
check("the host entry exists on disk", fs.existsSync(path.join(root, pkg.exports?.["."] ?? "")),
  pkg.exports?.["."]);
check("the host entry is real source, not a build product",
  (pkg.exports?.["."] ?? "").endsWith(".js") && !/dist|build|out\//.test(pkg.exports?.["."] ?? ""),
  pkg.exports?.["."]);

// --- the client half ---------------------------------------------------
check("the package declares a client entry", typeof pkg.exports?.["./client"] === "string",
  JSON.stringify(pkg.exports?.["./client"]));
check("the client entry exists on disk", fs.existsSync(path.join(root, pkg.exports?.["./client"] ?? "")),
  pkg.exports?.["./client"]);
check("the client entry is the source file, served directly",
  pkg.exports?.["./client"] === "./client.js", pkg.exports?.["./client"]);
check("the client is declared as a web platform module",
  pkg.dsh?.client?.platform === "web", JSON.stringify(pkg.dsh?.client?.platform));

// --- no build step -----------------------------------------------------
{
  const scripts = pkg.scripts ?? {};
  const buildish = ["prepare", "prepublish", "prepublishOnly", "prebuild", "build", "compile"].filter((name) => name in scripts);
  check("the plugin has no build step that must run before it works", buildish.length === 0, buildish.join(", "));
  // And nothing in the manifest points at a compiled directory.
  const serialized = JSON.stringify(pkg);
  check("no manifest path points into a build output directory",
    !/"\.\/(?:dist|build|out|lib\/client)/.test(serialized), "a dist/build/out path appeared in package.json");
}

// --- the entry files are the ones the gates test -----------------------
// If `exports` pointed somewhere other than the files the test suite exercises, every
// gate could pass while the shipped code was different. Cheap to assert, and it is the
// assumption all 50 gates rest on.
check("the host entry is lib/host-service.js's own package entry", pkg.exports?.["."] === "./index.js",
  pkg.exports?.["."]);
check("index.js is what registers the tools and the service",
  fs.readFileSync(path.join(root, "index.js"), "utf8").includes("registerPaperTools"));

// --- the client half is what the client gates read ---------------------
{
  const clientSource = fs.readFileSync(path.join(root, "client.js"), "utf8");
  check("client.js is the file the panel tests load", clientSource.includes("INPUT_METHODS"),
    "the client source does not declare INPUT_METHODS");
  // The arity fix from the previous round must be present in the file that ships.
  check("the shipped client does not wrap the zero-input backupStatus",
    !/"backupStatus"/.test(clientSource.slice(
      clientSource.indexOf("INPUT_METHODS = new Set(["),
      clientSource.indexOf("]);", clientSource.indexOf("INPUT_METHODS = new Set([")),
    )));
  check("the shipped client wraps the annotation RPCs",
    /"saveAnnotation",\s*"listAnnotations",\s*"deleteAnnotation",\s*"promoteAnnotation"/.test(clientSource));
}

// --- the deployment link -----------------------------------------------
// A profile that links to a different checkout would serve code the gates never saw.
{
  const require = createRequire(import.meta.url);
  void require;
  const profileRoot = process.env.DSH_PROFILE_DIR
    ?? path.join(process.env.USERPROFILE ?? "", ".dsh-desktop", "profiles", "desktop");
  const linked = path.join(profileRoot, "node_modules", "@local", "paper-tool");
  if (!fs.existsSync(linked)) {
    console.log("  info the desktop profile is not present on this machine; link check skipped");
  } else {
    const resolved = fs.realpathSync(linked);
    check("the profile links to this checkout", path.resolve(resolved) === path.resolve(root),
      "profile -> " + resolved + " , package -> " + root);
    const profilePkg = path.join(profileRoot, "package.json");
    if (fs.existsSync(profilePkg)) {
      const body = fs.readFileSync(profilePkg, "utf8");
      check("the profile lists the plugin as a bundle", body.includes("@local/paper-tool"));
    }
  }
}

console.log("");
if (failures.length > 0) {
  console.log("PLUGIN-ENTRY FAILED (" + failures.length + "):");
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("PLUGIN-ENTRY PASS");

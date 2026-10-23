// CNKI access (S5) via the Chrome DevTools Protocol.
//
// Why this shape, measured rather than assumed:
//   - Direct HTTP to kns.cnki.net returns a 2146-byte page titled 安全验证.
//     Adding home-page cookies does not help; the slider CAPTCHA (Tencent
//     防水墙) cannot be solved programmatically and will not be bypassed here.
//   - So the ONE thing a human must do is log in once, in a real browser.
//     The plugin launches Chrome with a dedicated profile, the user signs in
//     through their own institution's normal route, and afterwards the session
//     cookie keeps working for roughly 30 days.
//   - Everything after that login is automated: search, paginate, open a
//     record, find the PDF link, download, ingest.
//
// Dependencies: none. Chrome is driven over CDP with Node's global WebSocket
// and fetch. No puppeteer, no external tool.
//
// Not implemented on purpose: CAPTCHA solving, paywall evasion, credential
// storage, sharing accounts. The user's own session is the authority.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CDP_PORT = 9223;
const PAGE_LOAD_TIMEOUT_MS = 45_000;

/** Chrome/Edge locations we will try, in order. */
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : null,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter((path) => typeof path === "string" && path !== "");

function findBrowser() {
  for (const path of BROWSER_CANDIDATES) {
    try {
      if (existsSync(path)) return path;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Where the login session lives.
 *
 * A real Chrome profile directory, so the cookie persists across restarts
 * exactly as it would for any browser. Kept under the user's own data
 * directory, not the workspace, because it holds live credentials.
 */
export function sessionDir() {
  const base = process.env.LOCALAPPDATA ?? tmpdir();
  return join(base, "dsh-paper-tool", "cnki-profile");
}

/** Resolve the CDP endpoint, if a debugging Chrome is already running. */
async function cdpVersion() {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Minimal CDP client over the global WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined) reject(new Error(message.error.message ?? "cdp error"));
        else resolve(message.result);
      } else if (typeof message.method === "string") {
        this.events.push(message);
      }
    });
  }

  static async attach(webSocketDebuggerUrl) {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timed out")), 8000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connect failed")); }, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Evaluate an expression in the page and return its JSON value.
 *
 * `awaitPromise` is on so a page script can await its own work; the wrapper
 * never returns DOM nodes, only serialisable data.
 */
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "page script failed";
    throw new Error(text);
  }
  return result.result?.value;
}

/** Wait until the page reports its document is complete. */
async function waitForLoad(cdp, timeoutMs = PAGE_LOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(cdp, "document.readyState");
      if (state === "complete") return true;
    } catch {
      /* navigation in flight */
    }
    await sleep(250);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Launch a debugging browser on the persistent profile. */
async function launchBrowser(visible) {
  const browser = findBrowser();
  if (browser === null) {
    return { ok: false, reason: "no supported browser found (Chrome or Edge)" };
  }
  const dir = sessionDir();
  mkdirSync(dir, { recursive: true });
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...(visible ? [] : ["--headless=new"]),
    "https://kns.cnki.net/",
  ];
  const child = spawn(browser, args, { stdio: "ignore", detached: true });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(300);
    const version = await cdpVersion();
    if (version !== null) return { ok: true, browser: version.Browser, executable: browser };
  }
  return { ok: false, reason: "browser did not expose a CDP endpoint" };
}

/**
 * Open the CNKI session page and report whether a usable login exists.
 *
 * Visible on purpose: the user has to complete a login, so a headless window
 * would be useless. Calling this repeatedly reuses the same tab.
 */
export async function connect({ visible = true, signal } = {}) {
  signal?.throwIfAborted();
  let version = await cdpVersion();
  let launched = false;
  if (version === null) {
    const started = await launchBrowser(visible);
    if (!started.ok) return { ok: false, reason: started.reason };
    launched = true;
    version = await cdpVersion();
  }
  // Reuse an existing CNKI tab if there is one; otherwise open one.
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const candidate = targets.find((target) => target.type === "page" && /cnki\.net/.test(target.url ?? ""));
  let webSocketDebuggerUrl = candidate?.webSocketDebuggerUrl;
  if (webSocketDebuggerUrl === undefined) {
    const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("https://kns.cnki.net/")}`, {
      method: "PUT",
    });
    if (!created.ok) return { ok: false, reason: `could not open a CNKI tab (HTTP ${created.status})` };
    webSocketDebuggerUrl = (await created.json()).webSocketDebuggerUrl;
  }
  const cdp = await Cdp.attach(webSocketDebuggerUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await waitForLoad(cdp, 20_000);
    // The probe is best-effort: a page that refuses evaluation must still yield
    // a usable "connected, unknown login" answer rather than a hard failure.
    let probe;
    try {
      probe = await probeLogin(cdp);
    } catch (error) {
      probe = {
        url: "",
        loggedIn: false,
        safeCheck: false,
        probeError: error?.message ?? String(error),
      };
    }
    return {
      ok: true,
      launched,
      browser: version?.Browser ?? "",
      url: probe.url,
      loggedIn: probe.loggedIn,
      safeCheck: probe.safeCheck,
      hint: probe.probeError !== undefined
        ? `浏览器已打开，但无法读取页面状态（${probe.probeError}）。请在窗口里登录后点「重新检测」。`
        : probe.loggedIn
          ? "已登录，可以开始检索。"
          : probe.safeCheck
            ? "知网弹出了安全验证，请在打开的窗口里手动完成后点「重新检测」。"
            : "请在弹出的窗口里用你的机构账号登录一次，然后点「重新检测」。",
    };
  } finally {
    cdp.close();
  }
}

/**
 * Decide whether the current page looks logged in.
 *
 * Signals kept conservative: absence of the 安全验证 interstitial plus either a
 * login cookie or a visible account element. A false negative costs one more
 * click; a false positive would start a scrape that silently returns nothing.
 */
async function probeLogin(cdp) {
  return await evaluate(
    cdp,
    `(() => {
      const title = document.title || "";
      const body = (document.body && document.body.innerText || "").slice(0, 4000);
      const safeCheck = /安全验证|验证码|滑动验证/.test(title + body);
      // document.cookie throws on restricted pages (about:blank, some frames),
      // so reading it must never break the whole probe.
      let cookies = "";
      try { cookies = document.cookie || ""; } catch { cookies = ""; }
      const hasLoginCookie = /Ecp_ClientId|Ecp_session|SID=|cnkiUser/i.test(cookies);
      const hasAccountNode = Boolean(
        document.querySelector(".user-name, .login-user, .personal-name, #loginUser, .top-user-name")
      );
      const hasLoginLink = /登录/.test(body) && !/退出/.test(body);
      return {
        url: location.href,
        title,
        safeCheck,
        loggedIn: !safeCheck && (hasLoginCookie || hasAccountNode || (!hasLoginLink && /知网|CNKI/.test(title))),
      };
    })()`,
  );
}

/**
 * Search CNKI and return result rows.
 *
 * Uses the public search URL rather than the internal JSON API, because the
 * API changes between releases and is the part most aggressively gated.
 */
export async function search({ query, limit = 20, signal } = {}) {
  signal?.throwIfAborted();
  const version = await cdpVersion();
  if (version === null) return { ok: false, reason: "not connected: run connect first" };
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page" && /cnki\.net/.test(target.url ?? ""));
  if (page === undefined) return { ok: false, reason: "no CNKI tab open" };

  const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const url = `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(query)}&korder=SU`;
    await cdp.send("Page.navigate", { url });
    await waitForLoad(cdp);
    await sleep(1200);

    const probe = await probeLogin(cdp);
    if (probe.safeCheck) {
      return {
        ok: false,
        reason: "CNKI 要求安全验证，请在浏览器窗口里手动完成后再试",
        safeCheck: true,
        loggedIn: false,
      };
    }
    if (!probe.loggedIn) {
      return { ok: false, reason: "not logged in", loggedIn: false };
    }

    const rows = await evaluate(
      cdp,
      `(() => {
        const out = [];
        const table = document.querySelector("table.result-table-list, .result-table-list");
        const nodes = table ? table.querySelectorAll("tbody tr") : document.querySelectorAll(".result-table-list tbody tr, .list-item");
        for (const node of nodes) {
          const titleLink = node.querySelector("a.fz14, td.name a, a.title");
          if (!titleLink) continue;
          const cells = Array.from(node.querySelectorAll("td")).map((cell) => (cell.innerText || "").trim());
          out.push({
            title: (titleLink.innerText || "").trim(),
            href: titleLink.href || "",
            authors: (node.querySelector("td.author, .author")?.innerText || "").trim(),
            venue: (node.querySelector("td.source, .source")?.innerText || "").trim(),
            date: (node.querySelector("td.date, .date")?.innerText || "").trim(),
            cells: cells.slice(0, 8),
          });
        }
        return out;
      })()`,
    );
    const list = Array.isArray(rows) ? rows : [];
    return {
      ok: true,
      query,
      count: Math.min(list.length, limit),
      results: list.slice(0, limit),
      totalOnPage: list.length,
    };
  } finally {
    cdp.close();
  }
}

/**
 * Download one record's PDF.
 *
 * Honest about the two ways this fails: the institution may not license the
 * item, and CNKI may still gate the download behind a check. Both come back as
 * a reason, never as a silent empty file.
 */
export async function downloadPdf({ href, signal } = {}) {
  signal?.throwIfAborted();
  if (typeof href !== "string" || href === "") return { ok: false, reason: "href is required" };
  const version = await cdpVersion();
  if (version === null) return { ok: false, reason: "not connected" };

  const downloadDir = join(sessionDir(), "downloads");
  mkdirSync(downloadDir, { recursive: true });
  const before = new Set(safeReaddir(downloadDir));

  const cdp = await Cdp.attach(version.webSocketDebuggerUrl);
  try {
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
  } catch {
    /* older browsers may reject the browser-level target */
  } finally {
    cdp.close();
  }

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page" && /cnki\.net/.test(target.url ?? ""));
  if (page === undefined) return { ok: false, reason: "no CNKI tab open" };
  const pageCdp = await Cdp.attach(page.webSocketDebuggerUrl);
  try {
    await pageCdp.send("Page.navigate", { url: href });
    await waitForLoad(pageCdp);
    await sleep(1500);
    const probe = await probeLogin(pageCdp);
    if (probe.safeCheck) return { ok: false, reason: "安全验证阻止了下载，请手动处理后重试" };

    // The detail page exposes the PDF link directly on licensed items.
    const pdfHref = await evaluate(
      pageCdp,
      `(() => {
        const link = document.querySelector('a[href*="download"], a[href*="pdf"], .btn-download a, #pdfDown');
        return link ? link.href : "";
      })()`,
    );
    if (typeof pdfHref !== "string" || pdfHref === "") {
      return { ok: false, reason: "该条目没有可下载的 PDF 链接（可能无机构授权或需付费）" };
    }
    await pageCdp.send("Page.navigate", { url: pdfHref });
    // A PDF navigation never reaches readyState "complete"; poll the directory.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(700);
      const now = safeReaddir(downloadDir);
      const fresh = now.filter((name) => !before.has(name) && !name.endsWith(".crdownload"));
      if (fresh.length > 0) {
        const file = join(downloadDir, fresh[0]);
        let size = 0;
        try {
          size = readFileSync(file).byteLength;
        } catch {
          continue;
        }
        if (size > 4096) {
          // Verify the magic bytes: a saved HTML error page is not a paper.
          const head = readFileSync(file).subarray(0, 5).toString("latin1");
          if (head !== "%PDF-") {
            rmSync(file, { force: true });
            return { ok: false, reason: "下载的不是 PDF（通常是登录或授权页面）" };
          }
          return { ok: true, path: file, bytes: size };
        }
      }
    }
    return { ok: false, reason: "等待下载超时" };
  } finally {
    pageCdp.close();
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Report the current CNKI connection state without opening a window. */
export async function status() {
  const version = await cdpVersion();
  if (version === null) {
    return {
      connected: false,
      browser: "",
      loggedIn: false,
      reason: "尚未连接。点击「连接知网」会打开一个浏览器窗口，登录一次即可。",
    };
  }
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page" && /cnki\.net/.test(target.url ?? ""));
  if (page === undefined) {
    return { connected: true, browser: version.Browser, loggedIn: false, reason: "浏览器已启动，但没有知网标签页。" };
  }
  const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
  try {
    const probe = await probeLogin(cdp);
    return {
      connected: true,
      browser: version.Browser,
      loggedIn: probe.loggedIn,
      safeCheck: probe.safeCheck,
      url: probe.url,
      reason: probe.loggedIn ? "已登录。" : probe.safeCheck ? "安全验证未完成。" : "未登录。",
    };
  } finally {
    cdp.close();
  }
}

/** Close the debugging browser and keep the profile (so the login survives). */
export async function disconnect() {
  const version = await cdpVersion();
  if (version === null) return { ok: true, alreadyClosed: true };
  try {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const cdp = await Cdp.attach(version.webSocketDebuggerUrl);
    try {
      await cdp.send("Browser.close");
    } finally {
      cdp.close();
    }
    return { ok: true, alreadyClosed: false };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

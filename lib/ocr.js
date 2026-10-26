// OCR via the OCR engine that ships with Windows.
//
// Why this engine: this plugin has no network access and must not require the
// user to install Tesseract or sign up for a cloud API. `Windows.Media.Ocr` is
// present on every Windows 10/11 install and can recognise both Simplified
// Chinese and English out of the box (verified on this machine: en-GB and
// zh-Hans-CN are both offered by AvailableRecognizerLanguages).
//
// The trade-off is real and is surfaced to the user rather than hidden: OCR
// text is machine-guessed, so a paper's material is marked "ocr" instead of
// "fulltext" and every page records that its text came from OCR.
//
// WinRT types are reached from PowerShell 5.1, which can project them; Node
// cannot. Each call therefore spawns one PowerShell process that recognises a
// whole batch of pages, so a 30-page scan costs one process, not thirty.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Languages we ask Windows for, in preference order. */
const PREFERRED_LANGUAGES = ["zh-Hans-CN", "en-GB", "en-US"];

/**
 * The PowerShell script that performs the recognition.
 *
 * It is a static string, never built from user input: page images are passed as
 * file paths in a separate argument file and only ever used as data. That keeps
 * a crafted PDF filename from reaching the command line as code.
 */
const PS_SCRIPT = String.raw`
param([string]$ManifestPath, [string]$ResultPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation?1"
})[0]

function Await($operation, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
$language = [Windows.Globalization.Language]::new($manifest.language)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) {
  Set-Content -Path $ResultPath -Value "{}" -Encoding UTF8
  exit 3
}

$results = @{}
foreach ($page in $manifest.pages) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($page.path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $ocr.Lines) { $lines += $line.Text }
    $results[[string]$page.index] = $lines
  } catch {
    $results[[string]$page.index] = $null
  } finally {
    $stream.Dispose()
  }
}
# Results go to a file, not stdout: the harness sandbox forbids a child process
# from writing to an inherited pipe, so stdout capture fails with EPERM.
Set-Content -Path $ResultPath -Value (ConvertTo-Json -Compress -InputObject $results -Depth 6) -Encoding UTF8
`;

/** Cache the probe: whether an engine exists cannot change while we run. */
let probePromise = null;

/**
 * Report OCR availability and the language that will actually be used.
 *
 * @returns {Promise<{available: boolean, language: string, languages: string[], reason?: string}>}
 */
export async function ocrAvailable() {
  if (probePromise === null) probePromise = probe();
  return await probePromise;
}

async function probe() {
  if (process.platform !== "win32") {
    return { available: false, language: "", languages: [], reason: "OCR needs the Windows built-in engine; this platform has none" };
  }
  const dir = await mkdtemp(join(tmpdir(), "paper-tool-ocr-probe-"));
  try {
    const scriptPath = join(dir, "probe.ps1");
    const resultPath = join(dir, "out.json");
    await writeFile(
      scriptPath,
      String.raw`
param([string]$ResultPath)
$ErrorActionPreference = "Stop"
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
$tags = @()
foreach ($lang in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $tags += $lang.LanguageTag }
Set-Content -Path $ResultPath -Value (ConvertTo-Json -Compress -InputObject $tags) -Encoding UTF8
`,
      "utf8",
    );
    await runPowerShellFile(scriptPath, resultPath, 30_000, ["-ResultPath"]);
    const languages = parseJson(await readFile(resultPath, "utf8"), []);
    if (!Array.isArray(languages) || languages.length === 0) {
      return { available: false, language: "", languages: [], reason: "no OCR language pack is installed" };
    }
    const language = PREFERRED_LANGUAGES.find((code) => languages.includes(code)) ?? languages[0];
    return { available: true, language, languages };
  } catch (error) {
    return { available: false, language: "", languages: [], reason: describe(error) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Recognise a batch of page images.
 *
 * One PowerShell process per batch. A page that fails to decode yields `null`
 * in the returned array so the caller can mark exactly which pages are missing
 * instead of presenting a half-read paper as complete.
 *
 * @param {Buffer[]} pngBuffers one PNG per page
 * @param {{language?: string}} [options]
 * @returns {Promise<{(string|null)}[]>} recognised text per page, null when the page failed
 */
export async function ocrPages(pngBuffers, options = {}) {
  if (!Array.isArray(pngBuffers) || pngBuffers.length === 0) return [];
  const status = await ocrAvailable();
  if (!status.available) throw new Error(`OCR unavailable: ${status.reason}`);
  const language = typeof options.language === "string" && options.language !== "" ? options.language : status.language;

  const dir = await mkdtemp(join(tmpdir(), "paper-tool-ocr-"));
  try {
    const pages = [];
    for (let index = 0; index < pngBuffers.length; index += 1) {
      const path = join(dir, `page-${index}.png`);
      await writeFile(path, pngBuffers[index]);
      pages.push({ index, path });
    }
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ language, pages }), "utf8");
    const scriptPath = join(dir, "ocr.ps1");
    await writeFile(scriptPath, PS_SCRIPT, "utf8");
    const resultPath = join(dir, "out.json");

    await runPowerShellFile(scriptPath, manifestPath, batchTimeout(pngBuffers.length), ["-ManifestPath"], resultPath);
    const parsed = parseJson(await readFile(resultPath, "utf8"), null);
    if (parsed === null) throw new Error("OCR engine returned unreadable output");
    return pngBuffers.map((_, index) => {
      const lines = parsed[String(index)];
      if (!Array.isArray(lines) || lines.length === 0) return null;
      return normalizeOcrText(lines.join("\n"));
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Recognition is roughly a second per page; give it generous headroom. */
function batchTimeout(pageCount) {
  return Math.min(600_000, 30_000 + pageCount * 15_000);
}

/**
 * Repair the spacing Windows OCR puts between CJK glyphs.
 *
 * Windows OCR emits every Chinese character as its own token — 「旅 游 经 济」.
 * Left as-is the text is unsearchable by the CJK path (a LIKE scan for
 * 「旅游」 matches nothing) and any quote lifted from it reads as broken
 * Chinese. Latin words and numbers are deliberately left alone, and a space is
 * kept where a digit or Latin run meets CJK so 「第 3 章」 stays legible.
 *
 * The replacement is repeated because one pass over a run of glyphs does not
 * join all neighbours: the regex consumes the separator it just matched.
 */
export function normalizeOcrText(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const cjk = "\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
  const joinGlyphs = new RegExp(`([${cjk}])\\s+(?=[${cjk}])`, "g");
  let out = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(joinGlyphs, "$1");
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseJson(text, fallback) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    // ConvertTo-Json can wrap short output; take the last JSON-looking line.
    const line = trimmed.split(/\r?\n/).filter((part) => part.trim().startsWith("{") || part.trim().startsWith("[")).pop();
    if (line === undefined) return fallback;
    try {
      return JSON.parse(line);
    } catch {
      return fallback;
    }
  }
}

function describe(error) {
  const message = String(error?.message ?? error ?? "unknown error");
  return message.split(/\r?\n/)[0].slice(0, 200);
}

function runPowerShellFile(scriptPath, manifestPath, timeoutMs, leadingArgs = [], resultPath = null) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...leadingArgs, manifestPath];
  if (resultPath !== null) args.push(resultPath);
  return spawnPowerShell(args, timeoutMs);
}

/**
 * Run PowerShell to completion.
 *
 * The child's stdio is `ignore` on purpose. Under the harness sandbox a child
 * process may not write to an inherited pipe, so capturing stdout fails with
 * EPERM; results are exchanged through files instead. Arguments use the array
 * form of `spawn`, so no shell parses them and a crafted path cannot become a
 * command.
 */
function spawnPowerShell(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`OCR engine timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 3) {
        reject(new Error("OCR engine has no recognizer for the requested language"));
        return;
      }
      if (code !== 0) {
        reject(new Error(`OCR engine exited ${code}`));
        return;
      }
      resolve(null);
    });
  });
}

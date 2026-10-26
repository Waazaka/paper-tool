// Bibliographic metadata recovery.
//
// The first version of this guessed from page-1 prose: `lines[0]` was the title
// and the first four-digit number was the year. Measured over 32 real papers that
// produced authors 0/32, venue 0/32, and a wrong title on 10/32 — journal running
// heads, "Full Terms & Conditions of access…", and typesetter slugs like
// "JTR1187334 1..18" all beat the real title, because on a typeset PDF the real
// title is not the first line.
//
// The correct values are almost always present, just somewhere else:
//
//   * XMP (`dc:title`, `dc:creator`, `prism:doi`) — written by Elsevier and most
//     modern publishers. Authoritative when present. 14/32 have a title here.
//   * The Info dictionary (`Title`, `Author`, `Subject`) — and `Subject` often
//     carries the whole citation: "Journal Name, 93 (2021) 102773. doi:…".
//   * The file name. Zotero writes "Author - Year - Title"; CNKI writes
//     "12、标题_作者". Both survived whatever mangled the PDF.
//   * Page-1 layout: the title is the largest type on the page. This is the only
//     reliable signal for Chinese PDFs from CNKI, which ship no XMP at all
//     (13/32 have a title, and Info.Author is the literal string "CNKI").
//
// Every field therefore carries where it came from and how much to trust it. A
// guess the user cannot identify as a guess is worse than an empty field: an
// empty field invites a fix, a wrong one gets cited.

/** Producers that write themselves into `Author`; they are not authors. */
const NOT_AUTHOR =
  /^(cnki|adobe|adobe systems|elsevier|c&m|servigistics.*|microsoft.*|reader.*|admin|administrator|user|unknown|none|pdf|acrobat.*|distiller.*|latex.*|tex|word.*)$/i;

/**
 * Strings that look like a title but are page furniture. Each pattern is here
 * because it actually won the "first line" contest on a real paper in the corpus.
 */
const TITLE_JUNK = [
  /^full terms\s*&\s*conditions/i, // Taylor & Francis cover sheet
  /^see discussions,?\s*stats/i, // ResearchGate cover sheet
  /^downloaded (from|by)\b/i,
  /^this (article|content) (was|is) downloaded/i,
  /^(empirical research article|original article|original research|research article|review article|short communication|editorial|book review|case report)$/i,
  /^(abstract|摘\s*要|关键词|引\s*言|结\s*论|参考文献)\b/i,
  /^(vol\.?|volume|no\.?|第\s*\d+\s*卷|第\s*\d+\s*期)\b/i,
  /\bdoi\s*[:：]/i,
  /^\s*\d+\s*$/, // bare page number
  // Typesetter slugs: "JTR1187334 1..18", "EM-IJCH200211 587..603". Both are the
  // print job's internal id, and both won the title contest on real papers.
  /^[a-z]{2,10}[-_]?[a-z]{0,10}\d{4,}\s+\d+\s*\.\.\s*\d+/i,
  /^\s*[A-Z]{2,6}-?[A-Z0-9]*\d{4,}\b/,
  /\b\d+\s*\.\.\s*\d+\s*$/, // ends in a page range
  /^(contents|table of contents|目\s*次)$/i,
  /©|\(c\)\s*\d{4}|all rights reserved/i,
  /^issn\b|^isbn\b/i,
  /^received\b|^accepted\b|^available online\b/i,
  /^https?:\/\//i,
  /^(introduction|methodology|methods|results|discussion|conclusion)$/i,
  // Affiliations leak in when the title line is missing.
  /^(school|college|faculty|department|institute|university|centre|center)\b/i,
  /大学|学院|研究所|研究中心\s*$/,
  // A "title" ending in a person's name glued on by a bad line join.
  /\s[\u4e00-\u9fff]{1,3}\s*[，,]\s*[\u4e00-\u9fff]{1,3}\s*$/,
];

/** Section headings and boilerplate that must never be mistaken for a venue. */
const VENUE_JUNK =
  /research limitations|implications|practical implications|originality|purpose|design\/methodology|findings|received|accepted|keywords|acknowledg|references|appendix|table \d|figure \d|school of|university|college|faculty|department|institute|abstract|摘\s*要|关键词|作者简介|基金项目|收稿日期|参考文献|中图分类号|文献标识码|文章编号/i;

/**
 * A venue is a journal or book title, so it must look like one: short, no prose
 * punctuation, no author name or affiliation attached. When nothing satisfies
 * this the field stays empty — an empty journal invites a correction, a wrong one
 * gets cited. Measured over 32 real papers, a looser rule filled 30/32 but most
 * were body sentences ("究表明: 山东省 17 个地级市…"), which is exactly the failure
 * mode this function exists to prevent.
 */
function looksLikeVenue(text) {
  const value = cleanValue(text);
  const length = measuredLength(value);
  // Real journal names are short. A 40-character "venue" is a sentence.
  if (length < 3 || length > 46) return false;
  if (VENUE_JUNK.test(value)) return false;
  if (junkTitleReason(value) !== null) return false;
  // Prose punctuation, and any colon: a Chinese abstract starts "内容提要: …",
  // and the head of that string is never a journal.
  if (/[。；;！!？?：:]/.test(value)) return false;
  // A comma or enumeration mark inside a "journal name" means a clause was
  // captured ("然而，现有文献的关注点…"). No journal title contains one.
  if (/[，、]/.test(value)) return false;
  // A leading bullet or page marker ("·３·新时代…") is a typeset footer.
  if (/^[·•\-\s\d]+/.test(value) && hasCjk(value)) return false;
  // A footer that leads with a full-width digit and a separator is a page number
  // glued to the running title, not a journal name.
  if (/^[\d０-９]+[·．\.、]\s*/.test(value)) return false;
  // CJK venue names are short — 地域研究与开发, 经济地理, 管理世界.
  if (hasCjk(value) && length > 22) return false;
  // Running heads carry a volume, year and page range; a name does not.
  if (/\d{4}\s*\)\s*\d{3,}/.test(value)) return false;
  if (/\b\d+\s*[(（]\s*(19|20)\d{2}\s*[)）]/.test(value)) return false;
  if (/,\s*(school|college|university|department|institute|faculty)\b/i.test(value)) return false;
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+,/.test(value)) return false;

  if (!hasCjk(value)) {
    // Latin venue: a title-cased name of at most 9 words. A sentence fragment
    // ("Previous researchers have do", "for tourism, humor and posit") fails the
    // capitalisation test, which is what separates a name from prose.
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length > 9) return false;
    // A journal name cannot end on a connector. "International Journal of" is a
    // truncation — the real name continues ("…of Hospitality Management") — and
    // storing the stump is exactly the kind of half-right value that gets cited.
    if (words.length > 1 && /^(of|and|the|for|in|on|at|to|a|an|&|de|la|le|und|y)$/i.test(words[words.length - 1])) {
      return false;
    }
    // Every significant word must start with a capital, or be a connector.
    const connector = /^(of|and|the|for|in|on|at|to|a|an|&|de|la|le|und|y)$/i;
    const badWord = words.filter((word) => {
      if (connector.test(word)) return false;
      if (/^[A-Z]/.test(word)) return false;
      if (/^[A-Z]{2,}/.test(word)) return false; // ISSN, ACM
      return true;
    });
    if (badWord.length > 0) return false;
    if ((value.match(/\b(the|of|and|is|are|was|were|that|this|have|has|been)\b/gi) ?? []).length > 4) return false;
  }

  // And it must read like a publication name in one of the two languages.
  return /(学报|杂志|研究|评论|经济|管理|地理|旅游|学刊|论坛|导刊|科学|大学|Journal|Review|Research|Studies|Science|Letters|Quarterly|Management|International|Bulletin|Transactions|Proceedings|Press|Economics|Tourism|Hospitality|Marketing|Annals|Advances|Perspectives|Frontiers|Psychology)/i.test(
    value,
  );
}
/**
 * Is this line page furniture (a running head or footer)?
 *
 * Journal names live in the margins, not in the body. Without this check the
 * venue search ranged over the whole page and filled the field with abstract
 * prose like "究表明: 山东省 17 个地级市…", which is worse than leaving it empty.
 */
function isPageFurniture(line, lines) {
  if (lines.length === 0) return false;
  const ys = lines.map((entry) => entry.y).filter((y) => Number.isFinite(y));
  if (ys.length === 0) return true;
  const top = Math.max(...ys);
  const bottom = Math.min(...ys);
  if (top === bottom) return true;
  // pdf.js y grows upward, so the largest y is the top of the page.
  const depth = (top - line.y) / (top - bottom);
  return depth <= 0.1 || depth >= 0.9;
}

/** A running head: "<journal name> 93 (2021) 102773" or "第 36 卷 第 3 期". */
function looksLikeRunningHead(text) {
  const value = String(text).trim();
  if (/\d{4}\s*\)\s*\d{3,}/.test(value)) return true; // Journal 93 (2021) 102773
  if (/^\d{4}\s*(年|,)?\s*(第\s*\d+\s*(期|卷))/.test(value)) return true; // 2020 年第 11 期
  if (/^(vol|volume)\.?\s*\d+/i.test(value)) return true;
  if (/第\s*\d+\s*卷/.test(value)) return true;
  if (/^\d{1,3}\s*$/.test(value)) return true;
  return false;
}

function junkTitleReason(text) {
  const value = String(text ?? "").trim();
  if (value === "") return "empty";
  for (const pattern of TITLE_JUNK) if (pattern.test(value)) return `junk:${pattern.source.slice(0, 24)}`;
  if (looksLikeRunningHead(value)) return "running-head";
  // A "title" that is only a journal name and a number is a header, not a title.
  return null;
}

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const hasCjk = (value) => CJK.test(String(value ?? ""));

/** Character-count based length, so a 12-character Chinese title is not "short". */
function measuredLength(text) {
  const value = String(text ?? "");
  let width = 0;
  for (const char of value) width += CJK.test(char) ? 2 : 1;
  return Math.round(width / 2);
}

function cleanValue(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    // A stray date fragment glued to the front of a header line: the Chinese
    // "2023 年 01 月" above "第 40 卷第 1 期" produced venues starting "月 ".
    .replace(/^[\s\u3000]*(?:年|月|日)\s*/, "")
    // Typeset bullets and affiliation markers used by CNKI author lines.
    .replace(/^[\s\u3000□■●○◆◇▪▫◦‣⁃·•*※]+/, "")
    .replace(/^[\s\u3000:：,，、.;；\-–—*]+/, "")
    .replace(/[\s\u3000:：,，、.;；\-–—*]+$/, "")
    .trim();
}

/** Read the XMP packet pdf.js already parsed, tolerating missing getters. */
export function readXmp(metadata) {
  const out = { title: "", authors: [], venue: "", doi: "", year: "", volume: "" };
  if (metadata === null || typeof metadata !== "object") return out;
  const get = (key) => {
    try {
      return metadata.get(key);
    } catch {
      return null;
    }
  };
  const title = get("dc:title");
  if (typeof title === "string") out.title = cleanValue(title);
  const creator = get("dc:creator");
  if (Array.isArray(creator)) out.authors = creator.map(cleanValue).filter(Boolean);
  else if (typeof creator === "string") out.authors = [cleanValue(creator)].filter(Boolean);
  const publication = get("prism:publicationName");
  if (typeof publication === "string") out.venue = cleanValue(publication);
  const doi = get("prism:doi") ?? get("dc:identifier");
  if (typeof doi === "string") out.doi = cleanDoi(doi);
  const cover = get("prism:coverDate") ?? get("prism:publicationDate");
  if (typeof cover === "string") {
    const match = String(cover).match(/\b(19|20)\d{2}\b/);
    if (match) out.year = match[0];
  }
  const volume = get("prism:volume");
  if (typeof volume === "string") out.volume = cleanValue(volume);
  return out;
}

function cleanDoi(value) {
  const match = String(value ?? "").match(/10\.\d{4,9}\/[^\s"'<>]+/);
  return match ? match[0].replace(/[.,;)\]]+$/, "") : "";
}

function pluckDoi(...candidates) {
  for (const candidate of candidates) {
    const found = cleanDoi(candidate);
    if (found !== "") return found;
  }
  return "";
}

/**
 * Parse the Info `Subject` that publishers stuff a whole citation into:
 *   "International Journal of Hospitality Management, 93 (2021) 102773. doi:…"
 *   "Journal of X, 50 (2022) 108-118."
 */
export function parseSubject(subject) {
  const out = { venue: "", year: "", volume: "", doi: "" };
  const value = cleanValue(subject);
  if (value === "") return out;
  out.doi = cleanDoi(value);
  const year = value.match(/\(?\b(19|20)\d{2}\b\)?/);
  if (year) out.year = (year[0].match(/\d{4}/) ?? [""])[0];
  // "<venue>, <volume> (<year>) <pages>"
  const shape = value.match(/^(.{3,120}?)[,;]\s*(\d{1,4})?\s*\(?((?:19|20)\d{2})\)?/);
  if (shape) {
    out.venue = cleanValue(shape[1]);
    if (shape[2]) out.volume = shape[2];
    out.year = shape[3] ?? out.year;
  } else {
    const bare = value.match(/^(.{3,120}?)[,;]\s*((?:19|20)\d{2})/);
    if (bare) {
      out.venue = cleanValue(bare[1]);
      out.year = bare[2];
    }
  }
  return out;
}

/**
 * Parse a file name. Two conventions in the corpus:
 *   Zotero: "Li 等 - 2021 - Title.pdf", "Chen和Li - 2021 - Title.pdf"
 *   CNKI:   "12、标题_作者.pdf", "标题_作者.pdf"
 */
export function parseFilename(filename) {
  const out = { title: "", authors: [], year: "" };
  const raw = String(filename ?? "").replace(/\.pdf$/i, "").trim();
  if (raw === "") return out;

  // Zotero: "<author> - <year> - <title>"
  const zotero = raw.match(/^(.+?)\s+-\s+((?:19|20)\d{2})\s+-\s+(.+)$/);
  if (zotero) {
    out.year = zotero[2];
    out.title = cleanValue(zotero[3]);
    const author = cleanValue(zotero[1]);
    // "Li 等" / "Chen和Li" name a first author only; keep it but mark it short.
    if (author !== "" && !/^et al\.?$/i.test(author)) {
      out.authors = [author.replace(/\s*等$/, "").replace(/和.*$/, "").trim()];
    }
    return out;
  }

  // CNKI: "<serial>、<title>_<author>" or "<title>_<author>"
  let body = raw.replace(/^\s*\d+\s*[、.．]\s*/, "");
  const underscore = body.lastIndexOf("_");
  if (underscore > 0) {
    const author = cleanValue(body.slice(underscore + 1));
    const title = cleanValue(body.slice(0, underscore));
    if (title !== "") out.title = title;
    if (author !== "" && !NOT_AUTHOR.test(author)) out.authors = [author];
    return out;
  }
  out.title = cleanValue(body);
  return out;
}

/**
 * Rebuild page-1 lines with their type size, which is what separates a title from
 * a running head. pdf.js exposes `height` per text item; lines keep the largest
 * height of their items.
 */
export function layoutLines(items, { tolerance = 2 } = {}) {
  const lines = [];
  let current = null;
  for (const item of items ?? []) {
    if (typeof item.str !== "string") continue;
    const y = typeof item.transform?.[5] === "number" ? item.transform[5] : null;
    const height = typeof item.height === "number" ? item.height : 0;
    const startNewLine = current === null || (y !== null && Math.abs(y - current.y) > tolerance) || item.hasEOL;
    if (startNewLine) {
      if (current !== null) lines.push(current);
      current = { y: y ?? 0, height, text: item.str, hasEOL: Boolean(item.hasEOL) };
    } else {
      current.text += item.str;
      current.height = Math.max(current.height, height);
    }
    // `hasEOL` ends the line here so the next item starts a new one.
    if (item.hasEOL && current !== null) {
      lines.push(current);
      current = null;
    }
  }
  if (current !== null) lines.push(current);
  return lines
    .map((line) => ({ ...line, text: cleanValue(line.text) }))
    .filter((line) => line.text !== "");
}

/**
 * The title is the largest type near the top of page 1, possibly spanning two or
 * three lines. This is the only signal that works for CNKI PDFs, which carry no
 * XMP: their title sits at h=19.7 or 25.8 while every header is h=8.8.
 */
function titleFromLayout(lines) {
  if (lines.length === 0) return { title: "", height: 0 };
  const heights = lines.map((line) => line.height).filter((height) => height > 0);
  if (heights.length === 0) return { title: "", height: 0 };
  const tallest = Math.max(...heights);
  // Collect the tallest-type run, keeping lines in page order. A two-line title
  // has both lines at the same size ("新常态下中国经济增长" / "质量的评价体系构建与测度").
  const parts = [];
  let firstIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.height < tallest - 0.6) continue;
    if (junkTitleReason(line.text) !== null) continue;
    if (firstIndex < 0) firstIndex = index;
    parts.push({ text: line.text, index });
  }
  if (parts.length === 0) return { title: "", height: 0 };

  // Join. A CJK line break is a typesetting artifact, so no space is inserted —
  // the colon at the end of the first line is part of the title and must survive
  // ("…的影响：" + "一个链式中介模型"). Latin titles keep a space.
  let title = parts[0].text;
  for (const part of parts.slice(1)) {
    const bothCjk = hasCjk(title.slice(-1)) && hasCjk(part.text.slice(0, 1));
    title = bothCjk ? title + part.text : `${title} ${part.text}`;
  }
  // Normalise a half-width colon in Chinese text so the title reads as printed.
  if (hasCjk(title)) title = title.replace(/:$/, "：");

  // A Chinese title ending in a colon continues on the next line, usually set
  // smaller. Take it when it is clearly part of the same title.
  if (/[:：]$/.test(title)) {
    const lastIndex = parts[parts.length - 1].index;
    const next = lines[lastIndex + 1];
    if (next && next.height >= tallest * 0.5 && junkTitleReason(next.text) === null) {
      // Do not swallow the author line: it is smaller again and usually has
      // separators or a "等"/"和" pattern.
      const looksLikeAuthors = /[，,]\s*[\u4e00-\u9fff]{2,4}\s*$/.test(next.text) || /^\s*[\u4e00-\u9fff]{2,4}(\s+[\u4e00-\u9fff]{2,4})+\s*$/.test(next.text);
      if (!looksLikeAuthors) title += hasCjk(next.text.slice(0, 1)) ? next.text : ` ${next.text}`;
    }
  }

  title = cleanValue(title);
  if (junkTitleReason(title) !== null) return { title: "", height: 0 };
  if (measuredLength(title) < 4) return { title: "", height: 0 };
  if (measuredLength(title) > 300) title = title.slice(0, 300);
  return { title, height: tallest };
}

/** Authors sit directly under the title at a slightly smaller size. */
function authorsFromLayout(lines, titleHeight) {
  if (titleHeight <= 0) return [];
  const titleIndex = lines.findIndex((line) => line.height >= titleHeight - 0.6);
  if (titleIndex < 0) return [];
  for (let index = titleIndex; index < Math.min(lines.length, titleIndex + 5); index += 1) {
    const line = lines[index];
    if (line.height <= 0 || line.height >= titleHeight - 0.6) continue;
    // Author lines: names separated by spaces/commas/、, no sentence punctuation.
    if (/[。；;]/.test(line.text)) continue;
    if (/[（(]\s*\d/.test(line.text)) continue; // affiliation marker
    if (measuredLength(line.text) > 80) continue;
    if (NOT_AUTHOR.test(line.text)) continue;
    // "and" / "&" join author names; they are separators, not names. Replacing
    // them first stops "Shuhao Li and Min Wei" from becoming three "authors" with
    // "and" in the middle.
    const normalised = line.text.replace(/\s+(?:and|&|und)\s+/gi, ", ");
    const parts = normalised
      .split(/\s*[,，、;；]\s*|\s{2,}|\s(?=[A-Z\u4e00-\u9fff])/)
      .map(cleanValue)
      .filter((part) => part !== "" && part.length <= 40 && !NOT_AUTHOR.test(part));
    if (parts.length === 0) continue;
    // Rejoin a Latin given name with its surname. The separator pass splits
    // "Shuhao Li" into "Shuhao" and "Li", which would render as two authors.
    const allLatinName = parts.every((part) => /^[A-Z][a-z]+$/.test(part));
    if (allLatinName && parts.length % 2 === 0) {
      const paired = [];
      for (let i = 0; i < parts.length; i += 2) paired.push(`${parts[i]} ${parts[i + 1]}`);
      return paired;
    }
    return parts;
  }
  return [];
}

function pickYear(...candidates) {
  for (const candidate of candidates) {
    const match = String(candidate ?? "").match(/\b(19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return "";
}

/**
 * Recover bibliographic fields with per-field provenance.
 *
 * @param {string[]} pages extracted page text, page 1 first
 * @param {{info?: object, xmp?: object, layout?: object[], filename?: string}} [extra]
 * @returns {{
 *   title: string, authors: string, year: string, venue: string, doi: string,
 *   confidence: {title: string, authors: string, year: string, venue: string, doi: string},
 *   sources: {title: string, authors: string, year: string, venue: string, doi: string}
 * }}
 */
export function guessMetadata(pages, extra = {}) {
  const first = pages?.[0] ?? "";
  const info = extra.info ?? {};
  const xmp = extra.xmp ?? {};
  const layout = Array.isArray(extra.layout) ? extra.layout : [];

  const fromSubject = parseSubject(info.Subject ?? xmp["dc:description"] ?? "");
  const fromFile = parseFilename(extra.filename ?? "");

  const sources = { title: "", authors: "", year: "", venue: "", doi: "" };
  const confidence = { title: "low", authors: "low", year: "low", venue: "low", doi: "low" };

  // --- title ---------------------------------------------------------------
  let title = "";
  const xmpTitle = cleanValue(xmp.title ?? "");
  const infoTitle = cleanValue(info.Title ?? "");
  // XMP is authoritative *when it holds a title*. Some producers write the running
  // head there instead — "International Journal of Hospitality Management 94
  // (2021) 102880" — so the junk filter has to run before XMP wins, and the layout
  // (largest type on page 1) takes over when it does not.
  if (xmpTitle !== "" && junkTitleReason(xmpTitle) === null && measuredLength(xmpTitle) >= 4) {
    title = xmpTitle;
    sources.title = "xmp";
    confidence.title = "high";
  } else if (infoTitle !== "" && junkTitleReason(infoTitle) === null && measuredLength(infoTitle) >= 4) {
    title = infoTitle;
    sources.title = "info";
    confidence.title = "high";
  }
  if (title === "") {
    // Typeset PDFs have the real title in the largest type; that beats both the
    // first line and the file name, which are frequently a running head.
    const fromLayout = titleFromLayout(layout);
    if (fromLayout.title !== "") {
      title = fromLayout.title;
      sources.title = "layout";
      confidence.title = "medium";
    }
  }
  if (title === "" && fromFile.title !== "" && junkTitleReason(fromFile.title) === null) {
    title = fromFile.title;
    sources.title = "filename";
    confidence.title = "medium";
  }
  if (title === "") {
    // Last resort: the first line that survives the junk filter.
    for (const line of String(first).split("\n")) {
      const value = cleanValue(line);
      if (value === "" || junkTitleReason(value) !== null) continue;
      if (measuredLength(value) < 4) continue;
      title = value;
      sources.title = "page-text";
      confidence.title = "low";
      break;
    }
  }

  // --- authors -------------------------------------------------------------
  let authors = "";
  const xmpAuthors = (xmp.authors ?? []).filter((name) => name !== "" && !NOT_AUTHOR.test(name));
  const infoAuthor = cleanValue(info.Author ?? "");
  if (xmpAuthors.length > 0) {
    authors = xmpAuthors.join("; ");
    sources.authors = "xmp";
    confidence.authors = "high";
  } else if (infoAuthor !== "" && !NOT_AUTHOR.test(infoAuthor)) {
    authors = infoAuthor;
    sources.authors = "info";
    confidence.authors = "high";
  }
  if (authors === "") {
    const fromLayoutAuthors = authorsFromLayout(layout, titleFromLayout(layout).height);
    if (fromLayoutAuthors.length > 0) {
      authors = fromLayoutAuthors.join("; ");
      sources.authors = "layout";
      confidence.authors = "medium";
    }
  }
  if (authors === "" && fromFile.authors.length > 0) {
    // A Zotero file name gives the first author only ("Li 等"). Useful, incomplete.
    authors = fromFile.authors.join("; ");
    sources.authors = "filename";
    confidence.authors = "low";
  }

  // --- year ----------------------------------------------------------------
  // Order matters, and this list is deliberately conservative. Taking the first
  // four-digit number on page 1 — the old rule — picked whichever citation the
  // introduction happened to open with: one paper got "2013" from
  // "(Dong and Siu, 2013)" when it was published in 2021. The PDF creation date is
  // also excluded: it records when the file was produced, not when the paper
  // appeared.
  //
  // A copyright line, a volume year or a DOI prefix is evidence of the publication
  // year; a parenthesised year in running text is evidence of nothing.
  const copyrightYear = String(first).match(/(?:©|\(c\)|copyright)\s*((?:19|20)\d{2})/i)?.[1];
  // A journal footer states the year outright: "Vol. 33 No. 2, 2021", "第 40 卷
  // 第 1 期  2023 年 01". That is publication metadata, not prose, so it is a safe
  // source — unlike a year inside a citation, which is what the old rule grabbed.
  // The year may sit on a different line from the volume (Chinese headers put
  // "2023 年 01 月" above "第 40 卷第 1 期"), so these patterns span lines.
  const volumeYear =
    String(first).match(/\bVol\.?\s*\d+[\s\S]{0,60}?((?:19|20)\d{2})/)?.[1] ??
    String(first).match(/第\s*\d+\s*卷[\s\S]{0,40}?((?:19|20)\d{2})/)?.[1] ??
    // A leading "2023 年 01 月" / "2023 年 第 1 期" is the issue date.
    String(first).match(/^\s*((?:19|20)\d{2})\s*年/)?.[1];
  const year = pickYear(
    xmp.year,
    fromSubject.year,
    fromFile.year,
    copyrightYear,
    volumeYear,
  );
  if (year !== "") {
    sources.year =
      xmp.year === year ? "xmp"
      : fromSubject.year === year ? "subject"
      : fromFile.year === year ? "filename"
      : "page-text";
    confidence.year =
      sources.year === "xmp" || sources.year === "subject" ? "high"
      : sources.year === "filename" ? "medium"
      : "low";
  }

  // --- venue ---------------------------------------------------------------
  // `venue` used to be dead on arrival: importPdf passed `file.venue ?? ""` and the
  // import path never sets it, so the field was always empty. This is the actual
  // reason the user saw "journal name not recognised".
  let venue = "";
  if (xmp.venue !== "" && looksLikeVenue(xmp.venue)) {
    venue = xmp.venue;
    sources.venue = "xmp";
    confidence.venue = "high";
  } else if (fromSubject.venue !== "" && looksLikeVenue(fromSubject.venue)) {
    venue = fromSubject.venue;
    sources.venue = "subject";
    confidence.venue = "high";
  }
  if (venue === "") {
    // A journal running head sits at the very top or bottom of page 1, in small
    // type. Searching every line instead picks up abstract prose and section
    // headings, which is how "内容提要: …" used to become a journal name.
    //
    // The name is often PRINTED ACROSS SEVERAL LINES: Emerald sets
    //   "International Journal of" / "Contemporary Hospitality" / "Management"
    // as three stacked lines at the same size. Taking only the first produced the
    // stump "International Journal of", so adjacent lines of equal height are
    // joined before the name is validated.
    const furniture = layout.filter((line) => line.height < 12 && isPageFurniture(line, layout));
    for (let index = 0; index < furniture.length; index += 1) {
      const start = furniture[index];
      if (start.text === title || title.includes(start.text)) continue;
      let joined = start.text;
      // Extend forward while the next line keeps the same size and continues the
      // name (no sentence punctuation, still short).
      for (let step = index + 1; step < Math.min(furniture.length, index + 4); step += 1) {
        const next = furniture[step];
        if (Math.abs(next.height - start.height) > 0.5) break;
        if (/[。；;：:，、]/.test(next.text)) break;
        if (measuredLength(next.text) > 60) break;
        const candidate = `${joined} ${next.text}`;
        if (measuredLength(candidate) > 90) break;
        if (!looksLikeVenue(candidate)) break;
        joined = candidate;
      }
      if (looksLikeVenue(joined)) {
        venue = joined;
        sources.venue = "layout";
        confidence.venue = "medium";
        break;
      }
    }
  }
  // Final guard: an empty journal invites a correction, a wrong one gets cited.
  if (venue !== "" && !looksLikeVenue(venue)) venue = "";
  // A footer often prints the running title beside the page number, which is how
  // "３·新时代中国经济高质量发展水平的测度研究" became a "journal". If the venue
  // overlaps the title, it is the title, not a journal.
  if (venue !== "" && title !== "") {
    const bare = venue.replace(/^[\d０-９]+[·．\.、]\s*/, "");
    if (title.includes(bare) || bare.includes(title)) venue = "";
  }

  // --- doi -----------------------------------------------------------------
  const doi = pluckDoi(xmp.doi, fromSubject.doi, info.Subject, first);
  if (doi !== "") {
    sources.doi = xmp.doi === doi ? "xmp" : fromSubject.doi === doi ? "subject" : "page-text";
    confidence.doi = sources.doi === "xmp" || sources.doi === "subject" ? "high" : "medium";
  }

  return {
    title: title.slice(0, 300),
    authors: authors.slice(0, 500),
    year,
    venue: venue.slice(0, 200),
    doi,
    confidence,
    sources,
  };
}

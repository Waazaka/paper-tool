/**
 * Watch-folder support: turn "a PDF landed in this folder" into an import.
 *
 * The reason this is a module rather than a `fs.watch` call in the service is
 * that `fs.watch` alone produces the wrong answer in the case that matters. A
 * large PDF is copied in over several seconds; `change` fires while the file is
 * still being written. Extracting text from a half-written file either throws
 * or, worse, succeeds against a truncated document, and the library ends up with
 * a `failed` row or a paper whose text is the first 40% of the paper.
 *
 * So the rule is: nothing is imported until the file has stopped changing. That
 * decision is a pure function of two (size, mtime) samples — see
 * {@link isStable} — which makes it testable without a real watcher.
 *
 * Deliberately opt-in and single-folder: a background process that writes into
 * the user's library by default is how someone ends up with hundreds of papers
 * they never imported.
 */

/** @typedef {{ size: number, mtimeMs: number }} Sample */

/**
 * Whether two samples of the same file show it has stopped changing.
 *
 * Both signals are checked because either can stay constant on its own: a
 * growing file has a changing size, but a rewrite with the same length only
 * moves mtime. Requiring both to agree means a file that is merely being
 * re-timestamped is not treated as stable-by-size-accident.
 *
 * This answers only "are these two samples identical". The wall-clock floor —
 * how long the path must have been quiet — belongs to {@link SettleTracker},
 * which has the clock. Keeping the two apart is what makes each one testable
 * with a fake clock and no filesystem.
 *
 * @param {Sample | null | undefined} previous
 * @param {Sample | null | undefined} current
 * @returns {boolean}
 */
export function isStable(previous, current) {
  if (previous === null || previous === undefined) return false;
  if (current === null || current === undefined) return false;
  if (current.size === 0) return false;
  return previous.size === current.size && previous.mtimeMs === current.mtimeMs;
}

/**
 * Whether a path is a PDF worth importing.
 *
 * Case-insensitive and extension-only. Deliberately does not open the file: the
 * watcher must be able to reject junk without doing I/O on every event.
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function isPdfName(filename) {
  return typeof filename === "string" && /\.pdf$/i.test(filename);
}

/**
 * Track per-path samples and report when a path has settled.
 *
 * Kept separate from the watcher so the "settle" policy can be tested with a
 * fake clock and no filesystem.
 */
export class SettleTracker {
  /**
   * @param {{ quietMs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.quietMs = Number.isFinite(options.quietMs) ? options.quietMs : 1500;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    /** @type {Map<string, { sample: Sample, at: number }>} */
    this.pending = new Map();
  }

  /**
   * Record a sample and say whether the path is ready to import.
   *
   * Returns `true` exactly once per settle: once reported, the sample is
   * cleared, so a later event starts a new observation rather than reporting the
   * same file twice.
   *
   * @param {string} path
   * @param {Sample} sample
   * @returns {boolean}
   */
  offer(path, sample) {
    const entry = this.pending.get(path);
    const now = this.now();
    if (entry === undefined) {
      this.pending.set(path, { sample, at: now });
      return false;
    }
    if (!isStable(entry.sample, sample)) {
      // Still moving: restart the clock from this newer sample, or a slow writer
      // would never be seen to settle.
      this.pending.set(path, { sample, at: now });
      return false;
    }
    const quietFor = now - entry.at;
    if (quietFor < this.quietMs) {
      // The file has stopped changing but has not been quiet long enough yet.
      // `at` must NOT move here: it records when the file last changed, and
      // pushing it forward on every poll means the quiet window never elapses
      // and a settled file is never imported. Only a changed sample resets it.
      this.pending.set(path, { sample, at: entry.at });
      return false;
    }
    this.pending.delete(path);
    return true;
  }

  /** @param {string} path */
  forget(path) {
    this.pending.delete(path);
  }

  reset() {
    this.pending.clear();
  }

  get size() {
    return this.pending.size;
  }
}

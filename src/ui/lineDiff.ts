/**
 * Line-level diff for the write_file confirmation - checklist item 8, design doc §9.6.
 *
 * §9.6 decided the *where*: "show a diff before applying, under any mode where `write_file` isn't
 * already unconditionally allowed ... reusing the same confirmation-UI primitive". It left the
 * dependency choice open - "no diff library is in package.json's dependencies yet ... a real,
 * small follow-up dependency choice (e.g. the `diff` package) when this is actually built".
 *
 * **Decided here: no dependency.** Three reasons, in order of weight:
 * - Only *line* granularity is needed. `diff` earns its keep on word- and character-level diffs
 *   with intraline highlighting; none of that is in item 8's scope, which is "removed lines red,
 *   added lines green below them".
 * - §9.2's dependency audit (85 packages, zero native modules) is a stated asset of this project,
 *   and design criterion #3 is ease of install. A line LCS is ~40 lines.
 * - A diff shown before an irreversible overwrite is exactly the code whose failure modes should
 *   be ours to see. The size guard below is the clearest example: a general library would happily
 *   run a quadratic match on a 50k-line file and stall the dialog that is supposed to appear
 *   before the write.
 *
 * Display only. What gets written is the unchanged tool input, as with every other preview.
 */

export type DiffKind = 'same' | 'removed' | 'added';

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
}

/**
 * Above this many lines on either side, the LCS table is not built at all.
 *
 * The table is O(before x after) cells; at 3000 x 3000 that is nine million, which is both slow
 * and a lot of memory to allocate while a user waits for a dialog. Past it, `diffLines` degrades to
 * "the whole file is replaced", which is honest and instant - and a 3000-line diff was never going
 * to be read in an 8-line preview anyway.
 */
export const MAX_DIFF_LINES = 3000;

/** Splits into lines without inventing a trailing empty one for a file that ends in a newline. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * A longest-common-subsequence line diff.
 *
 * Classic DP, walked back from the end so equal runs come out in order. Not Myers: Myers is the
 * better algorithm for large inputs, and `MAX_DIFF_LINES` means large inputs never get here, so
 * the simpler table is the one with fewer places to be subtly wrong.
 *
 * Removed lines are emitted **before** the added lines they were replaced by, which is what item 8
 * asks for in so many words ("removed lines red, added lines green below them").
 */
export function diffLines(before: string, after: string): readonly DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length === 0 && b.length === 0) return [];
  // A new file: everything is an addition. Worth special-casing before the guard below, so
  // creating a big file still shows as additions rather than as a replacement of nothing.
  if (a.length === 0) return b.map((text) => ({ kind: 'added', text }) as const);
  if (b.length === 0) return a.map((text) => ({ kind: 'removed', text }) as const);

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ kind: 'removed', text }) as const),
      ...b.map((text) => ({ kind: 'added', text }) as const),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] });
  return out;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'added') added++;
    else if (line.kind === 'removed') removed++;
  }
  return { added, removed };
}

/** An elision marker: `kind: 'same'` with this exact text is rendered as a gap, not as context. */
export const ELISION = '…';

/**
 * Trims a diff to what fits in a dialog: the changed lines, a little context around them, and a
 * single marker wherever unchanged lines were dropped.
 *
 * Without this, a one-line change to a 400-line file produces a 400-line "diff" whose 399 identical
 * lines bury the one that matters - the same failure `confirmPreview.ts` was written to fix for the
 * content preview. `context` is small on purpose: the file is on disk and the point here is to
 * answer "is this the change I asked for", not to review it.
 *
 * Over `maxLines` the tail is dropped and a final marker says so, rather than the head: the first
 * change is the one that tells you whether the write is right.
 */
export function clipDiff(
  lines: readonly DiffLine[],
  maxLines: number,
  context = 2,
): readonly DiffLine[] {
  if (maxLines <= 0) return [];

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'same') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }

  const windowed: DiffLine[] = [];
  let elided = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      windowed.push(lines[i]);
      elided = false;
    } else if (!elided) {
      windowed.push({ kind: 'same', text: ELISION });
      elided = true;
    }
  }

  if (windowed.length <= maxLines) return windowed;
  // One slot reserved for the marker that says the rest was cut, so the result is never longer
  // than asked for.
  return [...windowed.slice(0, Math.max(0, maxLines - 1)), { kind: 'same', text: ELISION }];
}

/** `+3 -1`, or `no change`. The one-line summary shown next to the file name. */
export function formatDiffStats(stats: DiffStats): string {
  if (stats.added === 0 && stats.removed === 0) return 'no change';
  const parts: string[] = [];
  if (stats.added > 0) parts.push(`+${stats.added}`);
  if (stats.removed > 0) parts.push(`-${stats.removed}`);
  return parts.join(' ');
}

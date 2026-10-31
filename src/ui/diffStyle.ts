import stringWidth from 'string-width';
import { ELISION, type DiffKind, type DiffLine } from './lineDiff.js';
import type { CodeLine } from './syntaxHighlight.js';
import { diffColors, scopeColor } from './theme.js';

/**
 * A diff as the confirmation dialog draws it - checklist item 9, the same presentation Claude
 * Code uses for an edit:
 *
 * - a line-number gutter and the `+`/`-` marker;
 * - a dim red or green background across a changed line, syntax colours on top of it;
 * - a brighter background on the exact words that changed, when a removed line and the added line
 *   that replaced it are similar enough for that to mean something (`WORD_DIFF_LIMIT`).
 *
 * Pure: segments in, segments out. The dialog only maps them to `<Text>` and pads each changed line
 * to the dialog's width, which is the one thing that has to wait for render time.
 */

/** A run of text drawn in one style. */
export interface Segment {
  readonly text: string;
  readonly color?: string;
  readonly backgroundColor?: string;
}

export interface StyledDiffLine {
  readonly kind: DiffKind;
  /** True for the `…` that stands for dropped unchanged lines. */
  readonly elision: boolean;
  /** The line number, right-aligned to the widest in this diff; blank for an elision. */
  readonly gutter: string;
  /** `+`, `-` or a space. Part of the text, so a colourless terminal still shows the side. */
  readonly marker: string;
  readonly segments: readonly Segment[];
  /** The changed-line background, to pad the row with. Absent on context and elision lines. */
  readonly lineBackground?: string;
}

/** A half-open character range within a line. */
export interface Range {
  readonly start: number;
  readonly end: number;
}

/**
 * Above this share of changed characters, a removed/added pair is treated as a rewrite and gets no
 * word highlighting. Past roughly half, the bright background lands on most of both lines and
 * stops pointing at anything. Claude Code uses 0.4.
 */
export const WORD_DIFF_LIMIT = 0.4;

/** Lines with more tokens than this skip the word diff: its table is tokens x tokens. */
const MAX_WORD_TOKENS = 400;

/**
 * The diff, styled. `before` and `after` are the two versions highlighted whole (see
 * `highlightCode`), indexed by line number - pass `undefined` for either to draw that side plain.
 */
export function styleDiff(
  lines: readonly DiffLine[],
  before?: readonly CodeLine[],
  after?: readonly CodeLine[],
): StyledDiffLine[] {
  const width = Math.max(1, ...lines.map((l) => String(numberOf(l) ?? '').length));
  const words = pairWordChanges(lines);
  return lines.map((line, i) => {
    if (line.kind === 'same' && line.text === ELISION && numberOf(line) === undefined) {
      return {
        kind: 'same',
        elision: true,
        gutter: ' '.repeat(width),
        marker: ' ',
        segments: [{ text: ELISION, color: diffColors.gutter }],
      };
    }
    const number = numberOf(line);
    const code =
      line.kind === 'removed'
        ? lineAt(before, line.oldLine, line.text)
        : lineAt(after, line.newLine, line.text);
    const lineBackground =
      line.kind === 'removed' ? diffColors.removedLine : line.kind === 'added' ? diffColors.addedLine : undefined;
    const wordBackground =
      line.kind === 'removed' ? diffColors.removedWord : line.kind === 'added' ? diffColors.addedWord : undefined;
    return {
      kind: line.kind,
      elision: false,
      gutter: String(number ?? '').padStart(width),
      marker: line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ',
      segments: expandTabs(overlay(code, words.get(i) ?? [], lineBackground, wordBackground)),
      lineBackground,
    };
  });
}

function numberOf(line: DiffLine): number | undefined {
  return line.kind === 'removed' ? line.oldLine : line.newLine;
}

/**
 * The highlighted line, or the plain text when there is no highlighting or it does not match - a
 * mismatch would mean the diff and the highlighter disagree about the file, and the diff is the
 * one that has to be right.
 */
function lineAt(code: readonly CodeLine[] | undefined, number: number | undefined, text: string): CodeLine {
  const line = code && number !== undefined ? code[number - 1] : undefined;
  if (line && line.map((s) => s.text).join('') === text) return line;
  return text === '' ? [] : [{ text }];
}

/**
 * The word-level ranges for each line index that has them. A run of removed lines followed directly
 * by a run of added ones is read as a replacement, and paired off in order - the first removed line
 * with the first added one, and so on. Leftovers on either side are pure additions or removals and
 * get no word ranges.
 */
function pairWordChanges(lines: readonly DiffLine[]): Map<number, Range[]> {
  const ranges = new Map<number, Range[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'removed') {
      i++;
      continue;
    }
    const removedStart = i;
    while (i < lines.length && lines[i].kind === 'removed') i++;
    const addedStart = i;
    while (i < lines.length && lines[i].kind === 'added') i++;
    const pairs = Math.min(addedStart - removedStart, i - addedStart);
    for (let k = 0; k < pairs; k++) {
      const changes = wordChanges(lines[removedStart + k].text, lines[addedStart + k].text);
      if (!changes) continue;
      ranges.set(removedStart + k, changes[0]);
      ranges.set(addedStart + k, changes[1]);
    }
  }
  return ranges;
}

/** Words, runs of whitespace, and single punctuation characters. */
function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) ?? [];
}

/**
 * The changed character ranges of two similar lines: `[in old, in new]`. `undefined` when the lines
 * are too different for word highlighting to help, or too long to compare.
 */
export function wordChanges(oldText: string, newText: string): [Range[], Range[]] | undefined {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length > MAX_WORD_TOKENS || b.length > MAX_WORD_TOKENS) return undefined;

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const oldRanges: Range[] = [];
  const newRanges: Range[] = [];
  let i = 0;
  let j = 0;
  let oldPos = 0;
  let newPos = 0;
  let changed = 0;
  const mark = (into: Range[], start: number, length: number): void => {
    const last = into[into.length - 1];
    if (last && last.end === start) into[into.length - 1] = { start: last.start, end: start + length };
    else into.push({ start, end: start + length });
    changed += length;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      oldPos += a[i++].length;
      newPos += b[j++].length;
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      mark(oldRanges, oldPos, a[i].length);
      oldPos += a[i++].length;
    } else {
      mark(newRanges, newPos, b[j].length);
      newPos += b[j++].length;
    }
  }

  const total = oldText.length + newText.length;
  if (total === 0 || changed / total > WORD_DIFF_LIMIT) return undefined;
  return [oldRanges, newRanges];
}

/**
 * Splits the highlighted spans at the word-range boundaries, so each segment has one foreground
 * (from its syntax scope) and one background (the word's if it changed, else the line's).
 */
function overlay(
  code: CodeLine,
  ranges: readonly Range[],
  lineBackground: string | undefined,
  wordBackground: string | undefined,
): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const span of code) {
    const color = scopeColor(span.scope);
    let offset = 0;
    while (offset < span.text.length) {
      const at = pos + offset;
      const inside = ranges.find((r) => r.start <= at && at < r.end);
      const next = inside ? inside.end : Math.min(...ranges.filter((r) => r.start > at).map((r) => r.start), Infinity);
      const take = Math.min(span.text.length - offset, next - at);
      const backgroundColor = inside ? wordBackground : lineBackground;
      out.push({
        text: span.text.slice(offset, offset + take),
        ...(color ? { color } : {}),
        ...(backgroundColor ? { backgroundColor } : {}),
      });
      offset += take;
    }
    pos += span.text.length;
  }
  return out;
}

/**
 * A tab is drawn as two spaces: terminals disagree on its width, and the row padding needs one it
 * can count.
 */
function expandTabs(segments: Segment[]): Segment[] {
  return segments.map((s) => (s.text.includes('\t') ? { ...s, text: s.text.replaceAll('\t', '  ') } : s));
}

/**
 * The first lines of a file being created, numbered and coloured - item 9's second place, Claude
 * Code's new-file preview. Styled as context rows of a diff (no marker, no background) so the
 * dialog draws both with one component.
 *
 * Unlike a diff row, a preview row is **clipped** to `width` rather than wrapped: the preview's
 * height is what keeps the dialog inside the window (`confirmPreview.ts`), and a wrapped row is two.
 * `code` is the highlighted head of the file; `totalLines` is the whole file's count, for the tail.
 */
export function styleCodePreview(code: readonly CodeLine[], totalLines: number, width: number): StyledDiffLine[] {
  const gutterWidth = String(code.length).length;
  // Gutter, the space after it, and the marker column.
  const budget = Math.max(10, width - gutterWidth - 2);
  const rows: StyledDiffLine[] = code.map((line, i) => ({
    kind: 'same',
    elision: false,
    gutter: String(i + 1).padStart(gutterWidth),
    marker: ' ',
    segments: clipSegments(
      expandTabs(line.map((s) => ({ text: s.text, ...(scopeColor(s.scope) ? { color: scopeColor(s.scope) } : {}) }))),
      budget,
    ),
  }));
  const hidden = totalLines - code.length;
  if (hidden > 0) {
    rows.push({
      kind: 'same',
      elision: true,
      gutter: ' '.repeat(gutterWidth),
      marker: ' ',
      segments: [{ text: `... (+${hidden.toLocaleString('en-US')} more line${hidden === 1 ? '' : 's'})`, color: diffColors.gutter }],
    });
  }
  return rows;
}

/** Cuts segments to `budget` display columns, ending in `...` when anything was cut. */
function clipSegments(segments: Segment[], budget: number): Segment[] {
  const total = segments.reduce((n, s) => n + stringWidth(s.text), 0);
  if (total <= budget) return segments;
  const out: Segment[] = [];
  let left = budget - 3;
  for (const s of segments) {
    if (left <= 0) break;
    let text = '';
    for (const ch of s.text) {
      const w = stringWidth(ch);
      if (w > left) break;
      text += ch;
      left -= w;
    }
    if (text !== '') out.push({ ...s, text });
    if (text.length < s.text.length) break;
  }
  out.push({ text: '...', color: diffColors.gutter });
  return out;
}

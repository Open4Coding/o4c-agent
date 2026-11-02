/**
 * Where `edit_file`'s old_string is in a file, when the model did not copy it byte for byte (plan
 * 0006 B5). A ladder, stopping at the first rung that finds anything:
 *
 *  1. exact;
 *  2. exact after converting old/new to the file's line endings (a CRLF file, LF text);
 *  3. line by line, ignoring trailing whitespace;
 *  4. line by line, ignoring indentation - new_string is then re-indented by the same amount;
 *  5. rungs 1-4 again with \n, \t, \" and \\ unescaped, for a model that over-escaped its text.
 *
 * Every rung reports all its matches, so more than one is still refused unless replace_all is set:
 * a looser match never makes an edit land somewhere the model did not mean.
 */

export type MatchRung = 'exact' | 'line endings' | 'trailing whitespace' | 'indentation' | 'unescaped';

export interface EditMatch {
  rung: MatchRung;
  /** [start, end) offsets in the file, in order, non-overlapping. */
  ranges: Array<[number, number]>;
  /** new_string as it should be written for this rung (line endings, indentation). */
  replacement: string;
}

/** The file's line ending when it uses CRLF throughout, else LF. */
function eolOf(content: string): '\r\n' | '\n' {
  const crlf = content.split('\r\n').length - 1;
  const lf = content.split('\n').length - 1;
  return crlf > 0 && crlf === lf ? '\r\n' : '\n';
}

function toEol(text: string, eol: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

function exactRanges(content: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!needle) return out;
  let at = content.indexOf(needle);
  while (at >= 0) {
    out.push([at, at + needle.length]);
    at = content.indexOf(needle, at + needle.length);
  }
  return out;
}

interface Line {
  start: number;
  /** End of the text, before any \r\n or \n. */
  end: number;
  /** End including the line break. */
  next: number;
  text: string;
}

function linesOf(content: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start <= content.length) {
    const nl = content.indexOf('\n', start);
    const next = nl < 0 ? content.length : nl + 1;
    let end = nl < 0 ? content.length : nl;
    if (end > start && content[end - 1] === '\r') end -= 1;
    out.push({ start, end, next, text: content.slice(start, end) });
    if (nl < 0) break;
    start = next;
  }
  return out;
}

const leading = (s: string) => /^[ \t]*/.exec(s)![0];

function lineRanges(content: string, old: string, same: (a: string, b: string) => boolean): Array<{ range: [number, number]; first: number }> {
  let oldLines = old.replace(/\r\n/g, '\n').split('\n');
  const endsWithBreak = oldLines.length > 1 && oldLines[oldLines.length - 1] === '';
  if (endsWithBreak) oldLines = oldLines.slice(0, -1);
  if (oldLines.every((l) => l.trim() === '')) return [];
  const lines = linesOf(content);
  const out: Array<{ range: [number, number]; first: number }> = [];
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < oldLines.length && ok; k++) ok = same(lines[i + k].text, oldLines[k]);
    if (!ok) continue;
    const last = lines[i + oldLines.length - 1];
    out.push({ range: [lines[i].start, endsWithBreak ? last.next : last.end], first: i });
    i += oldLines.length - 1;
  }
  return out;
}

/**
 * new_string re-indented to the file. A new line indented like the old line in the same position
 * takes the indentation of the file line that old line matched - which recovers nesting even when
 * the model dropped all indentation; any other line is shifted by the first line's difference.
 */
function reindent(text: string, oldLines: readonly string[], fileLines: readonly string[]): string {
  const k0 = oldLines.findIndex((l) => l.trim() !== '');
  const from = leading(oldLines[k0] ?? '');
  const to = leading(fileLines[k0] ?? '');
  return text
    .split('\n')
    .map((line, k) => {
      if (line.trim() === '') return line;
      if (k < oldLines.length && k < fileLines.length && oldLines[k].trim() !== '' && leading(oldLines[k]) === leading(line)) {
        return leading(fileLines[k]) + line.trimStart();
      }
      return line.startsWith(from) ? to + line.slice(from.length) : to + line.trimStart();
    })
    .join('\n');
}

function ladder(content: string, oldString: string, newString: string): EditMatch | undefined {
  const eol = eolOf(content);
  const exact = exactRanges(content, oldString);
  if (exact.length) return { rung: 'exact', ranges: exact, replacement: eol === '\r\n' ? toEol(newString, eol) : newString };

  const oldEol = toEol(oldString, eol);
  const newEol = toEol(newString, eol);
  if (oldEol !== oldString) {
    const r = exactRanges(content, oldEol);
    if (r.length) return { rung: 'line endings', ranges: r, replacement: newEol };
  }

  const trailing = lineRanges(content, oldString, (a, b) => a.trimEnd() === b.trimEnd());
  if (trailing.length) return { rung: 'trailing whitespace', ranges: trailing.map((m) => m.range), replacement: newEol };

  const indented = lineRanges(content, oldString, (a, b) => a.trim() === b.trim());
  if (indented.length) {
    const oldLines = oldString.replace(/\r\n/g, '\n').split('\n');
    const fileLines = linesOf(content.slice(indented[0].range[0], indented[0].range[1])).map((l) => l.text);
    const replacement = toEol(reindent(newString.replace(/\r\n/g, '\n'), oldLines, fileLines), eol);
    return { rung: 'indentation', ranges: indented.map((m) => m.range), replacement };
  }
  return undefined;
}

function unescape(text: string): string {
  return text.replace(/\\(n|t|r|"|'|\\)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\' })[c] ?? c);
}

export function findEdit(content: string, oldString: string, newString: string): EditMatch | undefined {
  const found = ladder(content, oldString, newString);
  if (found) return found;
  // Over-escaped: literal \n sequences and no real line break is the tell.
  if (/\\[nt"\\]/.test(oldString) && !oldString.includes('\n')) {
    const again = ladder(content, unescape(oldString), unescape(newString));
    if (again) return { ...again, rung: 'unescaped' };
  }
  return undefined;
}

/** The lines of the file most like old_string's first line, numbered, for a miss. */
export function closestLines(content: string, oldString: string, context = 2): string | undefined {
  const target = oldString.replace(/\r\n/g, '\n').split('\n').find((l) => l.trim() !== '')?.trim();
  if (!target) return undefined;
  const words = new Set(target.split(/\W+/).filter(Boolean));
  if (words.size === 0) return undefined;
  const lines = linesOf(content);
  // Not the empty "line" after a final line break.
  if (lines.length > 1 && lines[lines.length - 1].start === content.length) lines.pop();
  let best = -1;
  let bestScore = 0;
  lines.forEach((l, i) => {
    const lw = new Set(l.text.trim().split(/\W+/).filter(Boolean));
    let common = 0;
    for (const w of words) if (lw.has(w)) common++;
    const score = common / Math.max(words.size, lw.size);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best < 0 || bestScore < 0.34) return undefined;
  const from = Math.max(0, best - context);
  const to = Math.min(lines.length, best + context + 1);
  return lines
    .slice(from, to)
    .map((l, k) => `${String(from + k + 1).padStart(5)}  ${l.text}`)
    .join('\n');
}

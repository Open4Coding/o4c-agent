import { estimateTextTokens } from '../agent/contextEntry.js';
import type { TruncatedToolOutput } from './toolOutput.js';

/**
 * Shape-aware shortening of an oversized tool result (plan 0006 B15), tried before the plain
 * head+tail cut. A failing test run is the motivating case: 5,000 lines, of which the model needs
 * the dozen that name a failure and where it happened - and the head+tail cut keeps the first
 * passing tests and the summary while dropping exactly those.
 *
 *  1. Runs of lines with the same shape (digits ignored) - "ok 1 - ...", "ok 2 - ...", compiler
 *     progress, a listing - collapse to their first and last line and a count. If that fits, done.
 *  2. Otherwise the lines that look like errors (error / fail / not ok / Traceback / assert / a
 *     `file:line` location) are kept with a little context, numbered by their line in the full
 *     output so `read_file` on the spill file can go straight to them, between a short head and tail.
 *
 * Returns undefined when neither applies - nothing repeats and nothing looks like an error, or so
 * much does that picking is no better than cutting - and the caller falls back to head+tail. The
 * full text is always on disk (the spill file); nothing here is the only copy.
 */

const MIN_RUN = 4;
const MIN_LINES = 20;
/** Longer lines are never tested for errors: the patterns are not linear on pathological input. */
const MAX_SIGNAL_LINE = 1000;
const SIGNAL = new RegExp(
  [
    String.raw`\b(error|errors|failed|failure|failures|failing|fatal|panic|exception|traceback|assert(ion)?error)\b`,
    String.raw`\bFAIL(ED)?\b`,
    String.raw`^\s*(not ok|✖|✗|×|E\s{2,})`,
    String.raw`\bat .+[:(]\d+:\d+\)?$`,
    String.raw`File ".+", line \d+`,
    String.raw`[\w./\\-]+\.(js|ts|tsx|jsx|mjs|cjs|py|go|rs|java|cs|c|cc|cpp|h|rb|php):\d+`,
    String.raw`\b(expected|actual|received)\b`,
  ].join('|'),
  'i',
);
const CONTEXT_BEFORE = 1;
const CONTEXT_AFTER = 2;

const shapeOf = (line: string) => line.trim().replace(/\d+/g, '#');

/** Lines with runs of same-shaped lines collapsed; each kept line remembers its 1-based number. */
function collapseRuns(lines: readonly string[]): { text: string; runs: number } {
  const out: string[] = [];
  let runs = 0;
  let i = 0;
  while (i < lines.length) {
    const shape = shapeOf(lines[i]);
    let j = i + 1;
    while (j < lines.length && shape !== '' && shapeOf(lines[j]) === shape) j++;
    const length = j - i;
    if (length >= MIN_RUN) {
      out.push(lines[i], `    ... ${length - 2} more lines like this (lines ${i + 2}-${j - 1}) ...`, lines[j - 1]);
      runs++;
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return { text: out.join('\n'), runs };
}

function marker(original: string, how: string, spillPath: string | undefined): string {
  return (
    `[o4c condensed this output: ${original.length.toLocaleString()} chars (~${estimateTextTokens(original).toLocaleString()} tokens), ${how}.` +
    (spillPath ? ` Full output: ${spillPath}. Read a slice with read_file offset/limit.` : '') +
    ']'
  );
}

/** As many of `lines` as fit in `budget` chars, from the start (or the end). */
function fit(lines: readonly string[], budget: number, fromEnd = false): string[] {
  const out: string[] = [];
  let used = 0;
  const ordered = fromEnd ? [...lines].reverse() : lines;
  for (const line of ordered) {
    if (used + line.length + 1 > budget) break;
    out.push(line);
    used += line.length + 1;
  }
  return fromEnd ? out.reverse() : out;
}

export function distillToolOutput(text: string, maxChars: number, spillPath?: string): TruncatedToolOutput | undefined {
  if (text.length <= maxChars) return undefined;
  const lines = text.split('\n');
  // Few, long lines (a minified file, one huge JSON blob) have no shape to work with, and testing a
  // multi-megabyte line against SIGNAL's patterns would backtrack for minutes.
  if (lines.length < MIN_LINES) return undefined;

  // 1. Collapse repetition.
  const collapsed = collapseRuns(lines);
  if (collapsed.runs > 0) {
    const head = marker(text, `${collapsed.runs} run(s) of similar lines collapsed`, spillPath);
    if (collapsed.text.length + head.length + 1 <= maxChars) {
      // After the first line, which stays first: often the command's own error ("maxBuffer exceeded").
      const cut = collapsed.text.indexOf('\n');
      return { text: `${collapsed.text.slice(0, cut)}\n${head}${collapsed.text.slice(cut)}`, truncated: true, originalChars: text.length };
    }
  }

  // 2. Errors first.
  const hits = lines.map((l, i) => (l.length <= MAX_SIGNAL_LINE && SIGNAL.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0 || hits.length > lines.length / 2) return undefined;
  const windows: Array<[number, number]> = [];
  for (const i of hits) {
    const from = Math.max(0, i - CONTEXT_BEFORE);
    const to = Math.min(lines.length - 1, i + CONTEXT_AFTER);
    const last = windows[windows.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else windows.push([from, to]);
  }

  const top = marker(text, `${hits.length} line(s) that look like errors or failures kept with context`, spillPath);
  const budget = maxChars - top.length - 200;
  const headLines = fit(lines.slice(0, windows[0][0]), Math.floor(budget * 0.12));
  const tailLines = fit(lines.slice(windows[windows.length - 1][1] + 1), Math.floor(budget * 0.2), true);
  let signalBudget = budget - headLines.join('\n').length - tailLines.join('\n').length;
  const blocks: string[] = [];
  let shownWindows = 0;
  for (const [from, to] of windows) {
    const block = [`--- lines ${from + 1}-${to + 1} ---`, ...lines.slice(from, to + 1)].join('\n');
    if (block.length + 1 > signalBudget) break;
    blocks.push(block);
    signalBudget -= block.length + 1;
    shownWindows++;
  }
  if (shownWindows === 0) return undefined;
  const more = shownWindows < windows.length ? [`--- ${windows.length - shownWindows} more error region(s) not shown; see the full output ---`] : [];
  const lead = headLines.length ? [headLines[0], top, ...headLines.slice(1), '...'] : [top];
  const body = [...lead, ...blocks, ...more, ...(tailLines.length ? ['...'] : []), ...tailLines].join('\n');
  return { text: body.slice(0, maxChars), truncated: true, originalChars: text.length };
}

import { grammarFor, highlightCode, type CodeLine } from './syntaxHighlight.js';

/**
 * Fenced code blocks in the model's replies - item 9's third place. The transcript keeps the reply
 * text exactly as written, fences included, so nothing about wrapping or layout changes; this only
 * decides which lines are code, and in which language, so the renderer can colour them.
 *
 * Two callers with the same rule. A finished reply (end of turn, `/resume`) is one multi-line text
 * and goes through `fencedSegments`. A streamed reply in `full` view arrives a line at a time and
 * each line is committed to scrollback before the next exists, so it goes through a `FenceTracker`
 * that remembers whether the previous line left a block open.
 */

/** What one line of a reply is. `code` carries its colours; a fence line is drawn dim. */
export type FenceRole =
  | { readonly role: 'prose' }
  | { readonly role: 'fence' }
  | { readonly role: 'code'; readonly code: CodeLine };

/** A block this long is highlighted a line at a time instead of as a whole - see `next`. */
const MAX_BLOCK_LINES = 400;

/** Opening fence: up to three spaces, three or more backticks or tildes, an optional info string. */
const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

export class FenceTracker {
  private fence: string | undefined;
  private grammar: string | undefined;
  private body: string[] = [];

  /** Classifies the next line of the reply, in order. */
  next(line: string): FenceRole {
    if (this.fence === undefined) {
      const open = OPEN.exec(line);
      if (!open) return { role: 'prose' };
      this.fence = open[1];
      this.grammar = open[2] ? grammarFor(open[2]) : undefined;
      this.body = [];
      return { role: 'fence' };
    }
    // A closing fence is the same character, at least as long, and nothing else on the line.
    const trimmed = line.trim();
    if (trimmed.length >= this.fence.length && trimmed === this.fence[0].repeat(trimmed.length)) {
      this.fence = undefined;
      return { role: 'fence' };
    }
    // The block so far, highlighted whole, so the second line of a block comment is still a
    // comment; only its last line is used. Quadratic in the block's length, hence the cap.
    this.body.push(line);
    const lines =
      this.body.length <= MAX_BLOCK_LINES ? highlightCode(this.body.join('\n'), this.grammar) : highlightCode(line, this.grammar);
    return { role: 'code', code: lines[lines.length - 1] ?? [] };
  }

  /** Forgets an open block - a reply interrupted by a tool call does not continue it afterwards. */
  reset(): void {
    this.fence = undefined;
    this.body = [];
  }
}

/** One run of a finished reply: prose, a fence line, or a span of code with its scope. */
export interface ReplySegment {
  readonly text: string;
  readonly kind: 'prose' | 'fence' | 'code';
  readonly scope?: string;
}

/**
 * A finished reply as segments, or `undefined` when it has no fenced block - the caller then draws
 * it exactly as before. Newlines stay inside the segments, so joining every segment's text gives
 * back the reply unchanged.
 */
export function fencedSegments(text: string): ReplySegment[] | undefined {
  if (!text.includes('```') && !text.includes('~~~')) return undefined;
  const tracker = new FenceTracker();
  const out: ReplySegment[] = [];
  const lines = text.split('\n');
  let sawFence = false;
  lines.forEach((line, i) => {
    const eol = i < lines.length - 1 ? '\n' : '';
    const role = tracker.next(line);
    if (role.role === 'code') {
      for (const span of role.code) out.push({ text: span.text, kind: 'code', ...(span.scope ? { scope: span.scope } : {}) });
      if (eol) out.push({ text: eol, kind: 'code' });
    } else {
      if (role.role === 'fence') sawFence = true;
      out.push({ text: line + eol, kind: role.role });
    }
  });
  return sawFence ? out : undefined;
}

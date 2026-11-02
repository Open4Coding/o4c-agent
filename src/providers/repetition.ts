/**
 * Notices a model chanting (plan 0006 B17): the same line, or the same block of lines, streamed
 * again and again. Qwen does this under pressure - a recorded run repeated a ten-line "Also the seed
 * content. Let me define the seeds: ... Now the app.js code. Let's write it all carefully." block
 * fifteen times, thousands of tokens of nothing, until the output limit ended it.
 *
 * Checked on whole lines of the streamed text and reasoning (never on tool-call arguments, where a
 * generated file can legitimately repeat). A block of 1 to MAX_BLOCK_LINES non-empty lines, at least
 * MIN_BLOCK_CHARS long, seen REPEATS times in a row is a loop. The length floor keeps ordinary
 * repetition - closing braces, blank separators, "ok" - from ever counting.
 */
export const REPEATS = 3;
const MIN_BLOCK_CHARS = 40;
const MAX_BLOCK_LINES = 12;

export class RepetitionDetector {
  private partial = '';
  private readonly lines: string[] = [];

  /** Feeds streamed text; returns the repeated block once a loop is seen. */
  push(delta: string): string | undefined {
    this.partial += delta;
    const parts = this.partial.split('\n');
    this.partial = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      this.lines.push(line);
      if (this.lines.length > REPEATS * MAX_BLOCK_LINES) this.lines.shift();
      const block = this.check();
      if (block) return block;
    }
    return undefined;
  }

  private check(): string | undefined {
    const n = this.lines.length;
    for (let p = 1; p <= MAX_BLOCK_LINES && p * REPEATS <= n; p++) {
      const block = this.lines.slice(n - p);
      if (block.join('\n').length < MIN_BLOCK_CHARS) continue;
      let same = true;
      for (let r = 1; r < REPEATS && same; r++) {
        for (let i = 0; i < p && same; i++) same = this.lines[n - p * (r + 1) + i] === block[i];
      }
      if (same) return block.join('\n');
    }
    return undefined;
  }
}

/**
 * Plan 0003 follow-up 3/4. When a request ends on an assistant message, llama-server treats it as a
 * prefill and resumes the sentence - but it echoes the prefill back, so the streamed content starts
 * with text the user has already seen (measured 2026-10-11: a prefix ending in "zorblaxian" came
 * back preserved and extended, 4/4 runs). In `full` session view the streamed deltas are committed
 * straight into scrollback as they arrive, so that echo appears on screen a second time.
 *
 * This suppresses the echoed run from the DISPLAY stream only. The provider still returns the full
 * content, because the entry written to history has to hold the complete assistant text - nothing
 * about history, compaction or the final answer changes.
 *
 * It is deliberately provider-local: Anthropic supports assistant prefill too but returns only the
 * continuation, with no echo to strip, so this must not live in the loop or the UI.
 */
export function createPrefillEchoFilter(
  prefill: string,
  onToken: (delta: string, kind: 'think' | 'text') => void,
): (delta: string, kind: 'think' | 'text') => void {
  // How much of `prefill` the text stream has matched so far. Once it reaches the end, or the
  // stream diverges, this filter is done and everything passes straight through.
  let matched = 0;
  let done = false;
  // Text withheld while it still might turn out to be the echo. Only ever a prefix of `prefill`,
  // so it is bounded by the prefill's own length.
  let held = '';

  return (delta, kind) => {
    // Reasoning deltas are never part of the echo - a continuation round opens no think block at
    // all (`reasoning_content` was 0 chars in every measured run) - so they pass through untouched
    // without disturbing the text match.
    if (done || kind !== 'text' || delta === '') {
      onToken(delta, kind);
      return;
    }

    const remaining = prefill.slice(matched);
    if (delta.length < remaining.length) {
      // Still inside the prefill: withhold it, as long as it is actually still matching.
      if (remaining.startsWith(delta)) {
        matched += delta.length;
        held += delta;
        return;
      }
    } else if (delta.startsWith(remaining)) {
      // This delta completes the echo. Emit only what comes after it, and stop filtering - the
      // rest of the stream is genuinely new text.
      done = true;
      held = '';
      const tail = delta.slice(remaining.length);
      if (tail !== '') onToken(tail, kind);
      return;
    }

    // Diverged, so this was never an echo: release whatever was withheld, in order, and get out of
    // the way for the remainder of the stream.
    done = true;
    const flushed = held + delta;
    held = '';
    if (flushed !== '') onToken(flushed, kind);
  };
}

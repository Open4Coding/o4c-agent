/**
 * Strips literal `<think>`/`</think>` tag markers out of a live delta stream, one chunk at a
 * time, without ever emitting a raw tag - a real invariant this codebase already guarantees for
 * the *final* answer (`splitThinkBlock()`, `contextEntry.ts`) and that streaming must not
 * silently break for the *live* preview (confirmed by a real, pre-existing test:
 * `App.test.tsx`'s "a <think> block shows live... never leaks into the final answer" asserts no
 * frame ever contains the literal string `<think>`).
 *
 * Reasoning content still streams through live (just without the tag wrapper) - this only
 * removes the markup, it doesn't hide or relabel what's inside it.
 *
 * `kind` (think vs. text) is threaded straight through from whoever calls `feed()` - this module
 * doesn't derive it (that's `loop.ts`'s job, itself just forwarding what the provider already
 * knows per-chunk; see `providers/types.ts`'s `onToken` doc comment). Only the *most recently fed*
 * kind is tracked (`bufferKind`), so anything emitted from the buffer - including a fragment held
 * back across a `feed()` call boundary - is labeled with whichever kind was current when it's
 * finally flushed out. A real transition (reasoning ending, the answer beginning) essentially
 * never lands mid-buffer in practice - by the time a `<think>`/`</think>` boundary is even
 * relevant, the buffer's already been drained on the previous call - so this is correct in the
 * overwhelming common case, not just a hopeful approximation.
 *
 * A tag can arrive split across two separate chunks (e.g. one chunk ends `...<th`, the next
 * starts `ink>...`) - `feed()` holds back any buffered tail that could be a partial prefix of
 * either tag, rather than emitting it (which would leak a fragment) or losing it (which would
 * drop real content). `flush()` must be called once the stream truly ends, emitting whatever's
 * still buffered verbatim - a `<think>` that's opened but never closed (the same "no end needed"
 * case `splitThinkBlock()` handles for the final text) must not silently swallow the rest of the
 * message.
 */
export function createThinkTagStripper(emit: (text: string, kind: 'think' | 'text') => void): {
  feed: (chunk: string, kind: 'think' | 'text') => void;
  flush: () => void;
} {
  const TAGS = ['<think>', '</think>'];
  let buffer = '';
  let bufferKind: 'think' | 'text' = 'text';

  function longestPartialSuffixMatch(text: string, pattern: string): number {
    const max = Math.min(text.length, pattern.length - 1);
    for (let len = max; len > 0; len--) {
      if (text.endsWith(pattern.slice(0, len))) return len;
    }
    return 0;
  }

  function feed(chunk: string, kind: 'think' | 'text'): void {
    buffer += chunk;
    bufferKind = kind;
    for (;;) {
      let bestIndex = -1;
      let bestTag = '';
      for (const tag of TAGS) {
        const index = buffer.indexOf(tag);
        if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
          bestIndex = index;
          bestTag = tag;
        }
      }
      if (bestIndex === -1) {
        const holdBack = Math.max(0, ...TAGS.map((tag) => longestPartialSuffixMatch(buffer, tag)));
        const safe = buffer.slice(0, buffer.length - holdBack);
        if (safe) emit(safe, bufferKind);
        buffer = buffer.slice(buffer.length - holdBack);
        return;
      }
      const before = buffer.slice(0, bestIndex);
      if (before) emit(before, bufferKind);
      buffer = buffer.slice(bestIndex + bestTag.length);
      // Loop again - more content (and possibly another tag) may already be sitting in `buffer`.
    }
  }

  function flush(): void {
    if (buffer) emit(buffer, bufferKind);
    buffer = '';
  }

  return { feed, flush };
}

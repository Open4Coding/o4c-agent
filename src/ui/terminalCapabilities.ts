/**
 * Best-effort detection of whether the current terminal likely supports the kitty keyboard
 * protocol (needed for Ctrl+Enter/Shift+Enter to arrive as a distinct signal from plain Enter -
 * see o4c-agent-design.md §2.1's "one real open item, not yet resolved").
 *
 * This is a heuristic, not a real negotiated result. Ink itself (`kittyKeyboard: { mode: 'auto' }`
 * in cli.ts) already does real protocol negotiation, but the outcome is stored on private fields
 * of its internal `Ink` class (`kittyProtocolEnabled`/`kittyFlags`) that aren't part of Ink's
 * public API - `render()`'s returned `Instance` doesn't expose them, and the module that holds the
 * live instance (`ink/build/instances.js`) isn't in Ink's `package.json` `exports` map, so
 * deep-importing it fails outright under Node's ESM resolution (`ERR_PACKAGE_PATH_NOT_EXPORTED`,
 * confirmed directly rather than assumed). Running a second, independent protocol probe
 * (write-a-query-sequence-and-read-the-response) was considered and rejected: it would race
 * against Ink's own already-in-flight negotiation for the same terminal responses.
 *
 * Instead this checks known environment-variable signals for terminals confirmed (via real
 * source code, not guesses - see the citations in o4c-agent-design.md §2.1) to support kitty-style
 * protocols: `cc`'s `terminal.ts:158` allowlists known-good terminal names the same way, rather
 * than assuming pure runtime negotiation. Deliberately conservative - unrecognized environments
 * report 'unknown' rather than guessing.
 */
export type KittyLikeSupport = 'likely' | 'unlikely' | 'unknown';

export function detectKittyLikeSupport(env: NodeJS.ProcessEnv = process.env): KittyLikeSupport {
  if (env.KITTY_WINDOW_ID) return 'likely'; // running inside kitty itself
  if (env.TERM_PROGRAM === 'ghostty') return 'likely';
  if (env.TERM_PROGRAM === 'iTerm.app') return 'likely'; // Codex's terminal_probe.rs special-cases this
  if (env.TERM_PROGRAM === 'vscode') return 'unlikely'; // VS Code's integrated terminal does not implement it
  // Windows Terminal only answers the kitty-protocol query on Preview 1.25+, not stable - no env
  // var distinguishes the two, so a bare WT_SESSION is genuinely 'unknown', not a guess either way.
  if (env.WT_SESSION) return 'unknown';
  return 'unknown';
}

export function describeKittyLikeSupport(support: KittyLikeSupport): string {
  if (support === 'likely') return 'Likely supported (heuristic) - else: plain Enter';
  if (support === 'unlikely') return 'Likely unsupported (heuristic) - falls back to plain Enter';
  return 'Unknown - Kitty terminals only if supported (else: plain Enter)';
}

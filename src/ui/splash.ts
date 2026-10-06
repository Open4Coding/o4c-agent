/**
 * The startup splash header - an "O4C" ASCII word-mark plus a snapshot of what this session is
 * actually running against (location, provider/model, starting mode). Rendered once into the
 * conversation's permanent scrollback, via the same `Line`/`TextBlock` system every other message
 * uses (see App.tsx's initial banner) - a snapshot of startup state, not a second copy of the
 * always-live "Mode: X" line already shown above the input box.
 *
 * Hand-rolled 5x5 block glyphs rather than a figlet-style dependency, matching this project's
 * established zero-extra-dependency footprint (see /keyboard's own hand-rolled table for
 * the same reasoning). 19 columns wide including gaps - safe even on a narrow terminal.
 */
const WORD_MARK = [
  '█████  █   █  █████',
  '█   █  █   █  █    ',
  '█   █  █████  █    ',
  '█   █      █  █    ',
  '█████      █  █████',
].join('\n');

export interface SplashInfo {
  /** `projectRoot` if trusted, otherwise the raw cwd - whichever this session is actually
   * operating in. Resolved by the caller (App.tsx already has `projectRoot` as a prop); this
   * module stays a pure string-formatter, no `process` access of its own. */
  location: string;
  provider: string;
  model: string;
  /** Only shown for the local provider - Anthropic's `baseUrl` is just its own fixed API
   * endpoint, not something a user configured or would recognize as meaningful here. */
  baseUrl?: string;
  modeLabel: string;
}

export function buildSplashText(info: SplashInfo): string {
  const providerLine = info.baseUrl
    ? `${info.provider} · ${info.model} · ${info.baseUrl}`
    : `${info.provider} · ${info.model}`;

  return [WORD_MARK, '', info.location, providerLine, `Mode: ${info.modeLabel}`].join('\n');
}

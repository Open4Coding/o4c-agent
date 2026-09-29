import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { moveVisualRow, rowStart, rowEnd } from './inputBoxLayout.js';
import { theme } from './theme.js';

export interface InputBoxProps {
  prompt?: string;
  disabled?: boolean;
  /** When false, this box stops reacting to keystrokes entirely - an overlay (ConfirmDialog,
   * SessionPicker) owns input instead. Default true. */
  active?: boolean;
  /** When true, Enter/↑/↓ are left alone here (a live overlay like CommandPalette owns them
   * instead) while normal typing, backspace, and cursor movement keep working. Default false. */
  suppressNav?: boolean;
  /** Fires with the current text on every edit - lets a parent drive something off the live
   * value (e.g. deciding whether to show the command palette) without owning the text itself. */
  onChange?: (value: string) => void;
  /** Bumping this (to any new number) clears the box's text/cursor without touching submit
   * history - used when a palette selection fills in and submits a command programmatically. */
  resetToken?: number;
  /** Bumping `token` (to any new number) replaces the box's text with `text`, cursor at the end,
   * without submitting or touching history - used when a picker selection (e.g. `/set`'s) fills
   * in a command name for the user to finish typing an argument onto, rather than auto-submitting
   * it the way a plain palette selection does. */
  prefill?: { token: number; text: string };
  onSubmit: (value: string) => void;
  /** Fires on a bare Escape press (never on Alt/Ctrl/Shift+Escape combos - Ink only reports
   * plain Escape as `key.escape` regardless of modifiers, so this fires for all of them alike).
   * Used to cancel an in-flight turn while the "Thinking..." spinner is up. Escape is always
   * swallowed here regardless of whether this is passed - see the regression test for why: Ink
   * has no named flag for it the way it does for Tab/Home/End, so an unhandled Escape would
   * otherwise fall through to plain character insertion and put a raw ESC byte into `value`. */
  onEscape?: () => void;
  /** Seeds the submit-history array (↑/↓ recall) on mount - used to restore a `/resume`d
   * session's own history, since a fresh process handoff (see `App.tsx`'s `restart`) mounts a
   * brand-new `InputBox` with no memory of the previous process. Read once, on mount only (like
   * `useState`'s own lazy initializer) - later changes to this prop do not reset live history,
   * the same one-way-on-mount contract `resetToken`/`prefill` use for their own triggers. */
  initialHistory?: string[];
  /** Fires with the full submit-history array every time it changes (i.e. on every submit that
   * isn't blank) - lets the caller (`App.tsx`) mirror it for persisting alongside the
   * conversation, without lifting the array itself into React state here (it only needs to be
   * read at save time, not drive a render). */
  onHistoryChange?: (history: string[]) => void;
}

/** Terminal columns actually usable for text inside the bordered, padded box - border
 * (1 char each side) + paddingX={1} (1 space each side) = 4 columns of fixed overhead. */
function contentWidth(columns: number | undefined): number {
  return Math.max(1, (columns ?? 80) - 4);
}

// SGR 48;2 (truecolor background) on, then SGR 49 (default background) off - deliberately not a
// full reset (`\x1B[0m`): background-only codes compose safely inside the single already-colored
// string this cursor cell gets spliced into (see cursorCell's own comment), leaving whatever
// foreground Ink already applied around the whole line untouched. `theme.accent` is amber
// (`#FFBF00`) - the cursor color requested directly, not the user's configurable highlightColor,
// since the caret is core chrome rather than a themeable accent.
const [CURSOR_R, CURSOR_G, CURSOR_B] = [
  Number.parseInt(theme.accent.slice(1, 3), 16),
  Number.parseInt(theme.accent.slice(3, 5), 16),
  Number.parseInt(theme.accent.slice(5, 7), 16),
];
const CURSOR_BG_ON = `\x1B[48;2;${CURSOR_R};${CURSOR_G};${CURSOR_B}m`;
const CURSOR_BG_OFF = '\x1B[49m';

/**
 * A bordered, auto-growing, genuinely multi-line-capable input box. `value` may contain real
 * embedded `\n` characters (Ctrl+J/Alt+Enter/a Kitty-reported Enter combo insert one - see #4a)
 * in addition to soft-wrapping at the terminal width. `<Text wrap="wrap">` (word-wrap, not
 * `"hard"`) renders both kinds of line break, breaking at spaces where possible and only
 * force-breaking mid-word when a single word exceeds the whole row width - switched from
 * `"hard"` after David reported long pasted text splitting words mid-character. `src/ui/
 * inputBoxLayout.ts` implements the matching cursor row/column math Up/Down/Home/End rely on
 * below by calling `wrap-ansi` itself (the exact library + options Ink's `wrap="wrap"` calls
 * internally) rather than a closed-form formula, since word-wrap's row boundaries depend on
 * where spaces actually fall - kept in its own module because it's involved enough to want
 * dedicated unit tests independent of a rendered terminal frame (`src/test/
 * inputBoxLayout.test.ts`), and is the single source of truth for that math.
 */
export function InputBox({
  prompt = '> ',
  disabled = false,
  active = true,
  suppressNav = false,
  onChange,
  resetToken,
  prefill,
  onSubmit,
  onEscape,
  initialHistory,
  onHistoryChange,
}: InputBoxProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  // Blinking cursor: toggles visibility on a timer, matching a real terminal caret rather than a
  // static highlight - only while this box is actually focused, since a blinking cursor on an
  // unfocused box would be misleading (nothing typed here would go anywhere). Deliberately NOT
  // gated on `disabled` too - real bug found via direct user report: while a turn is processing
  // (disabled=true, text grayed out), this box still genuinely accepts keystrokes for queueing
  // (see the "editing works even when disabled=true" test) - hiding the cursor made it look like
  // typing wasn't going anywhere when it actually was. 530ms matches common terminal-emulator
  // cursor blink rates (e.g. Windows Terminal's own default). Resets to visible on every focus
  // change AND on every edit or cursor move (depends on `value`/`cursor` too, not just `active`) -
  // matching real terminal behavior, where typing or moving the caret always shows it solid and
  // restarts the blink phase rather than leaving it to coincidentally land visible or not. Also
  // what makes this deterministic for tests that type/move and assert right after: without the
  // reset, a test whose own real elapsed time happened to cross a 530ms boundary since mount could
  // catch the cursor mid-"off" and see no highlight at all - a real flake found running this
  // file's own suite, not hypothetical.
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    if (!active) return;
    setCursorVisible(true);
    const id = setInterval(() => setCursorVisible((v) => !v), 530);
    // A cosmetic blink must never be a reason the process won't exit - real bug found running
    // this file's own test suite: none of these tests unmount their rendered InputBox, so a
    // plain (ref'd) interval from every single test accumulated and kept the whole test process
    // alive past every test actually finishing, hanging indefinitely instead of exiting.
    id.unref?.();
    return () => clearInterval(id);
  }, [active, value, cursor]);

  useEffect(() => {
    onChange?.(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    setValue('');
    setCursor(0);
    killedRef.current = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  useEffect(() => {
    if (!prefill) return;
    setValue(prefill.text);
    setCursor(prefill.text.length);
    killedRef.current = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.token]);

  // Ink 7 (v6.6.0+) parses raw Home/End escape sequences into native key.home/key.end itself
  // (confirmed in node_modules/ink/build/hooks/use-input.js) - this used to need a hand-rolled
  // stdin.read patch to see the real bytes directly, since Ink 5's public `key` object never
  // exposed them. That patch is gone; see key.home/key.end in the useInput callback below.
  const { stdout } = useStdout();

  // Submitted-input recall (up/down arrow), kept local to the input box - it only
  // needs the raw strings that were submitted, not anything about how they resolved. Seeded
  // once from `initialHistory` (a /resume restart handoff), same lazy-initializer-only contract
  // as `useState`'s own.
  const historyRef = useRef<string[]>(initialHistory ?? []);
  const historyIndexRef = useRef<number>(-1); // -1 = not currently browsing history
  const draftRef = useRef<string>(''); // what was being typed before browsing started
  // What Ctrl-U most recently killed (the bash/readline "kill ring", one slot deep) - the next
  // up-arrow press yanks it back in at the current cursor position instead of browsing history,
  // so an accidental Ctrl-U is one keystroke to undo rather than gone for good.
  const killedRef = useRef<string>('');

  useInput(
    (input, key) => {
      // Editing always works, even while `disabled` (busy) - that's what lets you type
      // ahead and queue up the next message instead of being locked out until the
      // current turn finishes. `onSubmit` always fires on Enter too; it's up to the
      // caller (App) to decide whether to run it now or hold it until it's free.
      // The hook's own isActive is tied to `active` (below) rather than left unconditionally
      // true, since a sibling overlay (ConfirmDialog, SessionPicker) has its own always-active
      // useInput holding raw mode whenever this one is deactivated - so it's still safe.
      if (key.escape) {
        // Ink has no named flag for Escape the way it does for e.g. Tab/Home/End - confirmed
        // directly against parse-keypress.js that a bare Escape's `input` stays as the raw ESC
        // byte (`'escape'` isn't in Ink's own `nonAlphanumericKeys` list, which is what would
        // normally clear it to ''). Left unhandled, that byte falls straight through to the
        // plain-character-insertion branch below and gets typed into `value` as a literal,
        // invisible control character - always swallow it here instead, whether or not a
        // handler is passed.
        onEscape?.();
        return;
      }
      if (key.return) {
        if (suppressNav) return; // CommandPalette owns Enter while it's open
        // Alt+Enter/Ctrl+Enter/Shift+Enter insert a literal newline instead of submitting.
        // Only Alt+Enter is universal: it arrives as the legacy "meta sends escape" sequence
        // (`ESC` + `\r`) that virtually every terminal sends by default, which Ink parses as
        // key.return + key.meta with zero protocol negotiation. Ctrl+Enter/Shift+Enter can
        // only be told apart from plain Enter at all on terminals that speak the Kitty
        // keyboard protocol (enabled in cli.ts) - Ctrl+M *is* Enter's own byte and Shift+Enter
        // carries no distinguishing byte otherwise, so key.ctrl/key.shift both stay false on a
        // non-Kitty terminal and this combo simply falls through to a plain submit below, which
        // is the best available fallback there. See docs/plans/0001.FrontEndIDEChanges.plan.md
        // #4a for the terminal-support research behind this split.
        if (key.meta || key.ctrl || key.shift) {
          historyIndexRef.current = -1;
          setValue((v) => v.slice(0, cursor) + '\n' + v.slice(cursor));
          setCursor((c) => c + 1);
          return;
        }
        const submitted = value;
        if (submitted) {
          historyRef.current.push(submitted);
          onHistoryChange?.(historyRef.current);
        }
        historyIndexRef.current = -1;
        draftRef.current = '';
        killedRef.current = '';
        setValue('');
        setCursor(0);
        onSubmit(submitted);
        return;
      }
      if (key.upArrow) {
        if (suppressNav) return; // CommandPalette owns ↑/↓ while it's open
        // Move up within the text first - across wrapped rows and real inserted newlines alike
        // (see inputBoxLayout.ts) - only once the cursor is already on the box's topmost visual
        // row (line 0's own row 0) does up-arrow fall through to the kill-ring yank / history
        // recall below.
        {
          const target = moveVisualRow(value, cursor, contentWidth(stdout.columns), prompt, 'up');
          if (target !== undefined) {
            setCursor(target);
            return;
          }
        }
        if (historyIndexRef.current === -1 && killedRef.current) {
          const killed = killedRef.current;
          killedRef.current = '';
          setValue((v) => v.slice(0, cursor) + killed + v.slice(cursor));
          setCursor((c) => c + killed.length);
          return;
        }
        const hist = historyRef.current;
        if (hist.length === 0) return;
        if (historyIndexRef.current === -1) {
          draftRef.current = value;
          historyIndexRef.current = hist.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        }
        const recalled = hist[historyIndexRef.current];
        setValue(recalled);
        setCursor(recalled.length);
        return;
      }
      if (key.downArrow) {
        if (suppressNav) return; // CommandPalette owns ↑/↓ while it's open
        // Symmetric with up-arrow above: move down within the text first, only falling through
        // to history once already on the box's bottommost visual row (the last line's last row).
        {
          const target = moveVisualRow(value, cursor, contentWidth(stdout.columns), prompt, 'down');
          if (target !== undefined) {
            setCursor(target);
            return;
          }
        }
        // Real bug found via hands-on testing, 2026-09-26: not browsing history yet (nothing
        // recalled via up-arrow) and already on the last line used to just do nothing here -
        // whatever was typed stayed stuck in the box with no way to clear it via down-arrow.
        // Fixed to clear the box, exactly like this - but not silently: the cleared text is
        // pushed into history first (the same push+onHistoryChange call Enter's own submit path
        // already makes), so it's stored and recallable via up-arrow later, and reaches the
        // session's persisted inputHistory the same way a real submission would, instead of
        // being discarded.
        if (historyIndexRef.current === -1) {
          if (value) {
            historyRef.current.push(value);
            onHistoryChange?.(historyRef.current);
          }
          setValue('');
          setCursor(0);
          return;
        }
        const hist = historyRef.current;
        if (historyIndexRef.current < hist.length - 1) {
          historyIndexRef.current += 1;
          const recalled = hist[historyIndexRef.current];
          setValue(recalled);
          setCursor(recalled.length);
        } else {
          historyIndexRef.current = -1;
          setValue(draftRef.current);
          setCursor(draftRef.current.length);
        }
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => c - 1);
        return;
      }
      // Home/End move within the current *visual row* (like a real text editor), not to the
      // absolute start/end of the whole buffer - David: "home and end should move to the home
      // and end of the line, not the input text." For never-wrapped (single-row) input this is
      // indistinguishable from jumping to the buffer's start/end, which is exactly what the
      // pre-existing tests below exercise; the distinction only shows up once the line has
      // wrapped into multiple rows (see the dedicated wrapped-row test).
      if (key.home) {
        setCursor(rowStart(value, cursor, contentWidth(stdout.columns), prompt));
        return;
      }
      if (key.end) {
        setCursor(rowEnd(value, cursor, contentWidth(stdout.columns), prompt));
        return;
      }
      // Ctrl-A/Ctrl-E: kept as the absolute whole-buffer start/end (the readline/bash
      // convention), distinct from Home/End's per-row behavior above - not asked for
      // explicitly, but a natural, useful complement (same relationship as an editor's
      // Home vs. Ctrl+Home).
      if (key.ctrl && input === 'a') {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'e') {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        // Bash convention: kill from line-start to the cursor only, leaving anything after
        // the cursor untouched - and stash what was killed so the next up-arrow can yank it
        // back in (see killedRef above), instead of an accidental Ctrl-U losing it for good.
        if (cursor > 0) {
          killedRef.current = value.slice(0, cursor);
          historyIndexRef.current = -1;
          setValue((v) => v.slice(cursor));
          setCursor(0);
        }
        return;
      }
      if (input === '\n') {
        // Ctrl+J (linefeed, 0x0A) - the one newline-insertion binding guaranteed to work on
        // every terminal with zero protocol negotiation, since it's a distinct raw byte from
        // Enter's 0x0D everywhere. Unlike Ctrl+Enter/Shift+Enter (see key.return above), this
        // needs no Kitty support to be told apart from plain Enter at all - Ink's own parser
        // already treats bare `\n` as its own named key ('enter', not 'return') rather than as
        // "ctrl+j" (confirmed in parse-keypress.js: the `\n` branch never sets key.ctrl), so it
        // reaches here as plain input text instead of via the key.ctrl branches above.
        historyIndexRef.current = -1;
        setValue((v) => v.slice(0, cursor) + '\n' + v.slice(cursor));
        setCursor((c) => c + 1);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) {
        // Normalize every line-break variant to a single real '\n' before it reaches `value` -
        // confirmed via a raw stdin capture that a real terminal paste of multi-line text
        // arrives as bare `\r` characters (not `\r\n`/`\n`), delivered as one single `input`
        // string in one keystroke event, not character-by-character. A literal `\r` written
        // straight to the terminal doesn't start a new line - it snaps the cursor back to
        // column 0 of the *current* row - so leaving it as-is corrupts the display exactly the
        // way #3's original large-paste bug did. Originally (before #5a) this collapsed every
        // run of line breaks to a single space instead, since the box couldn't render more than
        // one line at all yet - now that it genuinely can, David reported that as a bug in its
        // own right ("paste multi line does not maintain the cr lf"): pasting a multi-line
        // snippet should produce a multi-line entry, not one long space-joined line. `\r\n`
        // collapses to one `\n` (not two) so a Windows-style paste doesn't double every line;
        // every other `\r` or `\n` becomes its own `\n`, deliberately NOT collapsing runs, so a
        // blank line in the pasted content is preserved as a blank line rather than swallowed.
        const sanitized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        historyIndexRef.current = -1;
        setValue((v) => v.slice(0, cursor) + sanitized + v.slice(cursor));
        setCursor((c) => c + sanitized.length);
      }
    },
    { isActive: active },
  );

  // Regression fix (David: "go to the top line, and hit ctrl-j the cursor disappears"): if the
  // character right at the cursor is a real newline (cursor at the end of a non-final line, or
  // sitting on an empty line entirely - an empty line's own "start" position *is* its newline),
  // highlighting *it* renders nothing visible - a `\n` has no glyph to invert, so the inverse-
  // video SGR codes wrap an invisible character and the cursor appears to vanish. Confirmed
  // directly: `frame.includes('\x1B[7m')` was false the moment the cursor landed there.
  //
  // First attempt (looking forward past the `\n` to highlight the next real character instead)
  // was itself a real bug, caught by David's own follow-up test: David: "if 3 lines are inserted
  // ctrl-j x 3 at the beginning and you up two... the green box start moving down again" - three
  // Ctrl+J presses at position 0 creates three consecutive *empty* lines, each of which is
  // itself immediately its own `\n` with nothing before it; "look forward past every `\n`" skips
  // straight over all of them and highlights unrelated content several rows below where the
  // cursor logically is - the exact "stray green box in the wrong row" shape as the very first
  // bug this plan fixed (#2), just reintroduced a different way.
  //
  // Correct fix: insert one highlighted *space* immediately before the real `\n` - not a
  // replacement for it, an *addition* - so the newline is still present, unconsumed, right after
  // the highlight, and the line break still happens exactly where it always did. This puts the
  // cursor's visible marker on whichever row it logically belongs to (the end of a content line,
  // or an otherwise-empty line's own row) rather than jumping elsewhere. Only very narrowly not
  // layout-neutral: if a line's content happens to fill *exactly* `contentWidth` columns and the
  // cursor sits at its very end, this one extra character can push a highlighted space onto its
  // own extra row for as long as the cursor stays there - accepted as a rare, cosmetic-only edge
  // case rather than reintroducing either bug above.
  const rawAt = value.slice(cursor, cursor + 1);
  const isRealChar = rawAt !== '' && rawAt !== '\n';
  const before = value.slice(0, cursor);
  const at = isRealChar ? rawAt : ' ';
  const after = isRealChar ? value.slice(cursor + 1) : value.slice(cursor);
  // Inverse-video SGR codes applied directly to the string, then everything joined into ONE
  // string before it ever reaches <Text> - not left as separate {prompt}{before}{cursorCell}
  // {after} children (the previous shape, with the cursor cell as a nested <Text inverse>
  // child). Confirmed by capturing Ink's actual raw output bytes (both as a real terminal
  // frame and via ink-testing-library) that passing multiple sibling string/Text children to
  // one <Text> - not just the nested-<Text> case, a plain extra string child reproduced it too
  // - can push Ink's layout by one phantom row, splicing the cursor's cell into the Box's
  // border row below instead of the content row. Concatenating first and giving <Text> a
  // single string child measures correctly. `\x1B[7m`/`\x1B[27m` are exactly what Ink's own
  // `inverse` prop emits, so this is visually identical to the original nested-<Text> version.
  // Not gated on `disabled` - see the blink effect's own comment above for why: this box stays
  // genuinely live (queueing) while disabled, so the cursor should too.
  const cursorCell = !cursorVisible ? at : `${CURSOR_BG_ON}${at}${CURSOR_BG_OFF}`;
  const line = `${prompt}${before}${cursorCell}${after}`;

  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : theme.border} paddingX={1}>
      <Text wrap="wrap" color={disabled ? 'gray' : theme.accent}>
        {line}
      </Text>
    </Box>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout, useWindowSize } from 'ink';
import stringWidth from 'string-width';
import {
  inputWindow,
  movePageVisualRows,
  moveParagraph,
  moveVisualRow,
  rowStart,
  rowEnd,
} from './inputBoxLayout.js';
import { expandedInputBoxCapRows, inputBoxCapRows } from './frameBudget.js';

/** A paste this many lines or longer is shown as one placeholder line; ctrl-o expands it in place. */
const PASTE_COLLAPSE_LINES = 6;
/** Quiet time after the last chunk of a paste before the buffered chunks are inserted. */
const PASTE_SETTLE_MS = 60;
/** Terminal tab stop, in columns. Every terminal this app targets advances a `\t` to the next
 * multiple of 8; expanding to the same stops reproduces exactly what the terminal would have
 * drawn, so what's stored and what's shown have identical width. */
const TAB_STOP = 8;

/** Matches a whole ANSI escape sequence (CSI, OSC terminated by BEL or ST, and the short two-byte
 * ESC forms), so the sequence is removed entire rather than leaving its payload (`[31m`) behind as
 * literal text. Same shape as the `ansi-regex` package's pattern; inlined rather than adding a
 * dependency on a transitive package. */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
/** Any character left that the terminal would treat as a control rather than draw: a tab, any
 * other C0 control except `\n`, DEL, or a C1 control. */
// eslint-disable-next-line no-control-regex
const NEEDS_SANITIZING = /[\t\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/**
 * Makes `text` safe to put in the input box's value, where "safe" means every character it holds
 * occupies exactly the number of terminal columns that `string-width` reports for it.
 *
 * This is a correctness requirement, not cosmetics. Ink decides whether a line needs wrapping by
 * measuring it with `widest-line`/`string-width` (`node_modules/ink/build/dom.js`'s
 * `measureTextNode`), both of which score a `\t` as ZERO columns. A tab-indented line therefore
 * measures as fitting, Ink never wraps it, the raw tab reaches the terminal, and the terminal
 * expands it to the next tab stop - so the line really occupies two rows while Ink counted one.
 * Ink erases the previous frame with `eraseLines(previousLineCount)`, which moves up by that
 * undercounted number, so the top rows of the old box are never erased and stay on screen. Every
 * redraw (a cursor move, a keystroke) stacks another leftover.
 *
 * Measured directly against real Ink writing to a modelled terminal (`inputBoxStacking.test.tsx`,
 * 2026-10-05): the same 5-line paste indented with spaces gave `erases=10, ink lines=9,
 * real rows=9` - clean; indented with tabs it gave `erases=10, ink lines=9, real rows=11`, i.e.
 * two stale rows left behind per repaint. That is the stacked-input-box artifact David reported,
 * and it is independent of the box's height, which is why capping the box at 12 rows (tried
 * 2026-10-04, reverted) never fixed it.
 *
 * ANSI escapes get the same treatment for the same reason plus a worse one: pasting text copied
 * out of a coloured terminal carries SGR runs that bleed into neighbouring rows, and a stray CSI
 * physically moves the real cursor mid-frame. They are removed whole. `\r` normalising lives here
 * too - it was previously inline in the keystroke handler (see #3's original large-paste bug).
 */
export function sanitizeInputText(text: string): string {
  const newlines = text.replace(ANSI_SEQUENCE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!NEEDS_SANITIZING.test(newlines)) return newlines;
  return newlines
    .split('\n')
    .map((line) => {
      let out = '';
      let col = 0;
      for (const ch of line) {
        if (ch === '\t') {
          const pad = TAB_STOP - (col % TAB_STOP);
          out += ' '.repeat(pad);
          col += pad;
          continue;
        }
        const code = ch.codePointAt(0) ?? 0;
        // Remaining C0/DEL/C1 controls draw nothing but can move the cursor - drop them outright.
        if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
        out += ch;
        // Printable ASCII is always one column; anything else needs the real measurement. The fast
        // path matters: this runs over every character of a paste that can be tens of KB.
        col += code >= 0x20 && code <= 0x7e ? 1 : stringWidth(ch);
      }
      return out;
    })
    .join('\n');
}

/** The input box's whole mutable state: the text, and where the caret sits in it. Kept together
 * so a mid-tick edit can never apply a fresh value to a stale caret - see `edit` below. */
interface InputBuffer {
  value: string;
  cursor: number;
}

/** Collapsed pastes: placeholder text -> the full pasted text it stands for. Module scope, not a ref: an InputBox
 * remount (a turn ending, a restored prompt) must not lose the text its placeholders stand for. */
const pasteStore = new Map<string, string>();
let pasteCounter = 0;

/**
 * Empties the collapsed-paste store. Test-only: the store is module scope on purpose (an InputBox
 * remount must not lose the text its placeholders stand for), which means every test in a file
 * shares it - one test's submit clears it, and the next test's recalled placeholder then has
 * nothing behind it. That coupling made these tests pass alone and fail in sequence, with the
 * failure moving to whichever test happened to run next.
 */
export function resetPasteStoreForTests(): void {
  pasteStore.clear();
  pasteCounter = 0;
}

function expandPastes(text: string, pastes: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [placeholder, full] of pastes) out = out.split(placeholder).join(full);
  return out;
}

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
  /** Fires when Ctrl+O expands the box (true) and when it returns to its normal height (false).
   * The caller uses it to shrink the streamed live region by the rows the box just took - see
   * `frameBudget.liveRegionCapRowsFor`. Without it an expanded box and a running turn can each
   * stay within their own cap and still push the frame past the viewport together. */
  onExpandChange?: (expanded: boolean) => void;
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
  /** Bumping `token` appends `text` to the submit history (↑/↓ recall) without touching the box's
   * own text. Needed because a command chosen from the palette or a family dropdown is submitted
   * by the caller directly - it never passes through this box's Enter path, so it would otherwise
   * be missing from the history of things you just ran, which is exactly where you would look for
   * it. Ignores a repeat of the newest entry, so picking the same command twice doesn't stack. */
  historyAppend?: { token: number; text: string };
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

// Reverse video on, then off. SGR 7 swaps whatever foreground and background are active, so the
// cursor cell renders as a solid block in the line's own color with the character under it drawn
// in the terminal's background color - visible, rather than lost.
//
// That is the point of the change. The previous version set an explicit amber BACKGROUND and left
// the foreground alone, but the whole line is already amber: the character under the cursor was
// amber on amber, invisible everywhere except at the very end of the text, where the cursor sits
// on a space and there is nothing to hide (David, 2026-10-05: "can we do a highlight of the cursor
// position in something that is a different color so you can see the letter below?"). The explicit
// background arrived with the cursor blink in 98271c8 and outlived it - the blink itself was
// removed in 3a895d9 - so this is a leftover, not a deliberate choice.
//
// SGR 7/27 is also the only pair that composes safely here. The cell is spliced into one
// already-colored string, so an explicit foreground would need the surrounding color re-emitted
// after it, and `\x1B[39m` resets to the terminal's default rather than to the line's amber (or to
// its gray while disabled). Reverse video needs no restore at all: 27 turns it off and leaves both
// colors exactly as they were, so the cell is correct in both states. These are the same codes
// Ink's own `inverse` prop emits.
const CURSOR_ON = '\x1B[7m';
const CURSOR_OFF = '\x1B[27m';

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
  onExpandChange,
  onSubmit,
  onEscape,
  initialHistory,
  historyAppend,
  onHistoryChange,
}: InputBoxProps) {
  // The text and the caret are ONE piece of state, mutated only through `edit` below.
  //
  // They used to be two `useState`s, and every insert read `cursor` from its own render closure.
  // A terminal delivers a burst of keystrokes - fast typing, or a paste that Ink's parser splits at
  // an ESC or CR - as several `useInput` calls in the SAME tick, before React re-renders. Each of
  // those calls then saw the same stale caret, so they all inserted at the same offset and the text
  // came out in the wrong order: typing `abc` in one tick rendered `cba`, and a paste split into
  // chunks interleaved. Pinned by the two same-tick ordering tests in `InputBox.test.tsx`.
  //
  // `bufferRef` holds the authoritative value between renders, so an edit mid-tick composes on the
  // one before it instead of on whatever the last paint happened to show. The state exists purely
  // to trigger the re-render.
  const [buffer, setBuffer] = useState<InputBuffer>({ value: '', cursor: 0 });
  const bufferRef = useRef<InputBuffer>(buffer);
  /** The single way the text or caret changes. `fn` receives the latest buffer, not a rendered one. */
  const edit = (fn: (b: InputBuffer) => InputBuffer): void => {
    const next = fn(bufferRef.current);
    bufferRef.current = next;
    setBuffer(next);
  };
  const { value, cursor } = buffer;
  // Ctrl+O grew the box to show an expanded paste. Reset wherever the value is replaced wholesale
  // (submit, clear, history recall, prefill): the expanded height belongs to the text that was
  // expanded, and leaving it set would hold a tall box open over unrelated, short content.
  const [expanded, setExpanded] = useState(false);
  // A terminal delivers one paste as several input chunks. They are buffered and inserted together, so one paste
  // becomes one placeholder instead of one per chunk. Any other key flushes the buffer first, so Enter can't outrun it.
  const pendingPasteRef = useRef('');
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushPaste = (): void => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = undefined;
    }
    const text = pendingPasteRef.current;
    if (!text) return;
    pendingPasteRef.current = '';
    const insert = collapseText(text);
    historyIndexRef.current = -1;
    edit(({ value: v, cursor: c }) => ({
      value: v.slice(0, c) + insert + v.slice(c),
      cursor: c + insert.length,
    }));
  };

  // The cursor is a solid highlighted cell and never blinks. A blink repainted the whole live frame twice a
  // second (David could not see it blink in practice), while a solid cursor costs nothing and is always
  // visible - including while a turn runs and this box only queues keystrokes, so typing never looks dead.

  useEffect(() => {
    onChange?.(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const text = historyAppend?.text;
    if (!text) return;
    if (historyRef.current.at(-1) === text) return;
    historyRef.current.push(text);
    onHistoryChange?.(historyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyAppend?.token]);

  useEffect(() => {
    onExpandChange?.(expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  useEffect(() => {
    edit(() => ({ value: '', cursor: 0 }));
    setExpanded(false);
    killedRef.current = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  useEffect(() => {
    if (!prefill) return;
    const shown = collapseText(prefill.text);
    edit(() => ({ value: shown, cursor: shown.length }));
    setExpanded(false);
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
  // Long text arriving from outside the box (a paste, a recalled history entry, a restored prompt) is shown as a
  // placeholder too, so the box never jumps to a height that makes Ink commit its frames into scrollback.
  //
  // This is also the single funnel every piece of outside text passes through on its way into
  // `value` - a paste, a typed character, a `prefill`, an up/down-arrow history recall - so it is
  // where `sanitizeInputText` belongs. Sanitizing here rather than at each call site means the
  // text kept in `pasteStore` (and therefore what Enter submits) is the sanitized text too, so a
  // placeholder and the value it stands for can never disagree. It also covers history restored
  // from a session file written before this existed, which can still hold raw tabs.
  const collapseText = (rawText: string): string => {
    const text = sanitizeInputText(rawText);
    const lineCount = text.split('\n').length;
    if (lineCount < PASTE_COLLAPSE_LINES) return text;
    for (const [existing, full] of pasteStore) if (full === text) return existing;
    const placeholder =`[${lineCount} lines pasted #${++pasteCounter} - ctrl-O to view]`;
    pasteStore.set(placeholder, text);
    return placeholder;
  };
  // What Ctrl-U most recently killed (the bash/readline "kill ring", one slot deep) - the next
  // up-arrow press yanks it back in at the current cursor position instead of browsing history,
  // so an accidental Ctrl-U is one keystroke to undo rather than gone for good.
  const killedRef = useRef<string>('');

  useInput(
    (input, key) => {
      if (pendingPasteRef.current && !(input && input.length > 1)) flushPaste();
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
          edit(({ value: v, cursor: c }) => ({ value: v.slice(0, c) + '\n' + v.slice(c), cursor: c + 1 }));
          return;
        }
        const submitted = expandPastes(value, pasteStore);
        pasteStore.clear();
        if (submitted) {
          historyRef.current.push(submitted);
          onHistoryChange?.(historyRef.current);
        }
        historyIndexRef.current = -1;
        draftRef.current = '';
        killedRef.current = '';
        edit(() => ({ value: '', cursor: 0 }));
        setExpanded(false);
        onSubmit(submitted);
        return;
      }
      // Bulk movement through a long value, so a 200-line paste doesn't have to be crossed one
      // row at a time. These are checked BEFORE the plain arrow handlers below, which own history
      // recall - a Ctrl+arrow that fell through to those would browse history instead of moving.
      //
      // Binding choice: PageUp/PageDown and Ctrl+letter are the cross-platform safe baseline (see
      // osKeyboardNotes). Ctrl+arrow is accepted too, but only as an alias - it arrives as
      // `ESC[1;5A`, which Windows Terminal sends and Ink parses, while Terminal.app and several
      // Linux terminals never send it and tmux swallows it. Anything that only worked through the
      // alias would silently not exist on those terminals, so Ctrl+P/Ctrl+N carry the feature.
      if (key.pageUp || key.pageDown) {
        const rows = expanded ? expandedInputBoxCapRows(stdout.rows) : inputBoxCapRows(stdout.rows);
        edit((b) => ({
          ...b,
          cursor: movePageVisualRows(
            b.value,
            b.cursor,
            contentWidth(stdout.columns),
            prompt,
            rows,
            key.pageUp ? 'up' : 'down',
          ),
        }));
        return;
      }
      if ((key.ctrl && input === 'p') || (key.ctrl && key.upArrow)) {
        edit((b) => ({ ...b, cursor: moveParagraph(b.value, b.cursor, 'up') }));
        return;
      }
      if ((key.ctrl && input === 'n') || (key.ctrl && key.downArrow)) {
        edit((b) => ({ ...b, cursor: moveParagraph(b.value, b.cursor, 'down') }));
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
            edit((b) => ({ ...b, cursor: target }));
            return;
          }
        }
        if (historyIndexRef.current === -1 && killedRef.current) {
          const killed = killedRef.current;
          killedRef.current = '';
          edit(({ value: v, cursor: c }) => ({
            value: v.slice(0, c) + killed + v.slice(c),
            cursor: c + killed.length,
          }));
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
        const recalled = collapseText(hist[historyIndexRef.current]);
        edit(() => ({ value: recalled, cursor: recalled.length }));
        setExpanded(false);
        return;
      }
      if (key.downArrow) {
        if (suppressNav) return; // CommandPalette owns ↑/↓ while it's open
        // Symmetric with up-arrow above: move down within the text first, only falling through
        // to history once already on the box's bottommost visual row (the last line's last row).
        {
          const target = moveVisualRow(value, cursor, contentWidth(stdout.columns), prompt, 'down');
          if (target !== undefined) {
            edit((b) => ({ ...b, cursor: target }));
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
          const entry = expandPastes(value, pasteStore);
          if (entry && historyRef.current.at(-1) !== entry) {
            historyRef.current.push(entry);
            onHistoryChange?.(historyRef.current);
          }
          edit(() => ({ value: '', cursor: 0 }));
          setExpanded(false);
          return;
        }
        const hist = historyRef.current;
        if (historyIndexRef.current < hist.length - 1) {
          historyIndexRef.current += 1;
          const recalled = collapseText(hist[historyIndexRef.current]);
          edit(() => ({ value: recalled, cursor: recalled.length }));
          setExpanded(false);
        } else {
          historyIndexRef.current = -1;
          edit(() => ({ value: draftRef.current, cursor: draftRef.current.length }));
        }
        return;
      }
      if (key.leftArrow) {
        edit((b) => ({ ...b, cursor: Math.max(0, b.cursor - 1) }));
        return;
      }
      if (key.rightArrow) {
        edit((b) => ({ ...b, cursor: Math.min(b.value.length, b.cursor + 1) }));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        edit(({ value: v, cursor: c }) => ({ value: v.slice(0, c - 1) + v.slice(c), cursor: c - 1 }));
        return;
      }
      // Home/End move within the current *visual row* (like a real text editor), not to the
      // absolute start/end of the whole buffer - David: "home and end should move to the home
      // and end of the line, not the input text." For never-wrapped (single-row) input this is
      // indistinguishable from jumping to the buffer's start/end, which is exactly what the
      // pre-existing tests below exercise; the distinction only shows up once the line has
      // wrapped into multiple rows (see the dedicated wrapped-row test).
      if (key.home) {
        edit((b) => ({ ...b, cursor: rowStart(b.value, b.cursor, contentWidth(stdout.columns), prompt) }));
        return;
      }
      if (key.end) {
        edit((b) => ({ ...b, cursor: rowEnd(b.value, b.cursor, contentWidth(stdout.columns), prompt) }));
        return;
      }
      // Ctrl-A/Ctrl-E: kept as the absolute whole-buffer start/end (the readline/bash
      // convention), distinct from Home/End's per-row behavior above - not asked for
      // explicitly, but a natural, useful complement (same relationship as an editor's
      // Home vs. Ctrl+Home).
      if (key.ctrl && input === 'a') {
        edit((b) => ({ ...b, cursor: 0 }));
        return;
      }
      if (key.ctrl && input === 'e') {
        edit((b) => ({ ...b, cursor: b.value.length }));
        return;
      }
      if (key.ctrl && input === 'o') {
        // Expand every collapsed paste in the box, in the order they appear, replacing each
        // placeholder with the text it stands for - and grow the box to its expanded height so
        // there is somewhere to put it. The text becomes ordinary editable content; the box is a
        // window onto it, scrolled by moving the cursor.
        //
        // In-place expansion was removed on 2026-10-05 because it stacked copies of the box in
        // scrollback on every cursor move. That was never the expansion's fault: `string-width`
        // scores a tab as zero columns, so Ink under-counted a tab-indented line's width and its
        // erase moved up too few rows (see `sanitizeInputText`). With tabs no longer reaching the
        // frame, and the box bounded so the frame stays under the viewport, it is safe again -
        // `inputBoxStacking.test.tsx` holds it to one box on screen.
        const expandedValue = expandPastes(value, pasteStore);
        if (expandedValue === value) return;
        setExpanded(true);
        edit(() => ({ value: expandedValue, cursor: expandedValue.length }));
        return;
      }
      if (key.ctrl && input === 'u') {
        // Bash convention: kill from line-start to the cursor only, leaving anything after
        // the cursor untouched - and stash what was killed so the next up-arrow can yank it
        // back in (see killedRef above), instead of an accidental Ctrl-U losing it for good.
        if (cursor > 0) {
          killedRef.current = value.slice(0, cursor);
          historyIndexRef.current = -1;
          edit(({ value: v, cursor: c }) => ({ value: v.slice(c), cursor: 0 }));
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
        edit(({ value: v, cursor: c }) => ({ value: v.slice(0, c) + '\n' + v.slice(c), cursor: c + 1 }));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) {
        // Line-break normalizing, tab expansion and control/ANSI stripping all happen in
        // `sanitizeInputText`, which `collapseText` applies on the way into `value` - see both
        // functions for why each is a correctness requirement rather than tidying. The one note
        // worth keeping here: a real terminal paste of multi-line text arrives as bare `\r`
        // characters (not `\r\n`/`\n`), confirmed via a raw stdin capture, delivered as one
        // `input` string per chunk rather than character-by-character. A literal `\r` written
        // straight to the terminal doesn't start a new line - it snaps the cursor back to column
        // 0 of the *current* row - which is what corrupted the display in #3's original
        // large-paste bug.
        //
        // Chunks are buffered RAW and sanitized once at flush, deliberately: tab expansion is
        // column-relative, and a chunk boundary can fall mid-line, so sanitizing each chunk on
        // its own would measure a tab's column from the chunk's start instead of the line's.
        if (input.length > 1) {
          pendingPasteRef.current += input;
          if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
          pasteTimerRef.current = setTimeout(flushPaste, PASTE_SETTLE_MS);
          return;
        }
        const insert = collapseText(input);
        historyIndexRef.current = -1;
        edit(({ value: v, cursor: c }) => ({
          value: v.slice(0, c) + insert + v.slice(c),
          cursor: c + insert.length,
        }));
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
  const before = value.slice(0, cursor);
  const rawAt = value.slice(cursor, cursor + 1);
  const isRealChar = rawAt !== '' && rawAt !== '\n';
  const at = isRealChar ? rawAt : ' ';
  const after = isRealChar ? value.slice(cursor + 1) : value.slice(cursor);
  // The exact text that gets laid out, with that added space already in it when the cursor sits on
  // a newline or past the end. The window is measured against this rather than `value`, so the row
  // the cursor lands on is the row it is actually drawn on - measuring one string and rendering a
  // different one is how a cursor ends up highlighted in the wrong place.
  const valueWithCursor = isRealChar ? value : `${before} ${after}`;
  const cursorInValue = cursor;
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
  // Not gated on `disabled` either: this box stays genuinely live (queueing keystrokes) while a turn
  // runs, so the cursor stays visible too.
  const cursorCell = `${CURSOR_ON}${at}${CURSOR_OFF}`;

  // The box draws at most `inputBoxCapRows` rows of text, windowed around the cursor, however long
  // the value is. A frame as tall as the viewport cannot be erased in place - writing it scrolls
  // its own top rows into scrollback, where the next `eraseLines` cannot reach them - so an
  // unbounded box is what let a long value stack a copy of itself on every repaint. `inputWindow`
  // explains the windowing rules; `frameBudget` explains why this cap and the live region's share
  // one set of numbers.
  //
  // `useWindowSize` rather than reading `stdout.rows`/`columns` at render: the terminal is
  // resizable in both dimensions, and both matter here. A shorter window shrinks the budget; a
  // narrower one re-wraps the same text into more rows, so the window has to be recomputed from
  // the live size on every resize. This hook re-renders the component when either changes, instead
  // of relying on App happening to re-render the tree from its own resize effect.
  const { columns, rows } = useWindowSize();
  const width = contentWidth(columns);
  const capRows = expanded ? expandedInputBoxCapRows(rows) : inputBoxCapRows(rows);
  const view = inputWindow(valueWithCursor, cursorInValue, width, prompt, capRows);
  // The windowed rows are already wrapped to `width`, so `wrap="wrap"` has nothing left to do and
  // the rendered height is exactly what was budgeted - no surprise extra row.
  const body = view.rows
    .map((row, i) =>
      i === view.cursorRow
        ? row.slice(0, view.cursorCol) + cursorCell + row.slice(view.cursorCol + 1)
        : row,
    )
    .join('\n');
  const notices = [
    view.hiddenAbove > 0 ? `… ${view.hiddenAbove} more above` : undefined,
    view.hiddenBelow > 0 ? `… ${view.hiddenBelow} more below` : undefined,
  ];

  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : theme.border} paddingX={1} flexDirection="column">
      {notices[0] !== undefined && (
        <Text wrap="truncate-end" color={theme.border}>
          {notices[0]}
        </Text>
      )}
      <Text wrap="wrap" color={disabled ? 'gray' : theme.accent}>
        {body}
      </Text>
      {notices[1] !== undefined && (
        <Text wrap="truncate-end" color={theme.border}>
          {notices[1]}
        </Text>
      )}
    </Box>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

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
  onSubmit: (value: string) => void;
}

/**
 * A bordered, auto-growing input box. Ink's flexbox layout wraps the Text content and
 * grows the parent Box's height to fit as the line exceeds the terminal width - no
 * manual wrap-point math needed.
 */
export function InputBox({
  prompt = '> ',
  disabled = false,
  active = true,
  suppressNav = false,
  onChange,
  resetToken,
  onSubmit,
}: InputBoxProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    onChange?.(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    setValue('');
    setCursor(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  // Submitted-input recall (up/down arrow), kept local to the input box - it only
  // needs the raw strings that were submitted, not anything about how they resolved.
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1); // -1 = not currently browsing history
  const draftRef = useRef<string>(''); // what was being typed before browsing started

  useInput(
    (input, key) => {
      // Editing always works, even while `disabled` (busy) - that's what lets you type
      // ahead and queue up the next message instead of being locked out until the
      // current turn finishes. `onSubmit` always fires on Enter too; it's up to the
      // caller (App) to decide whether to run it now or hold it until it's free.
      // The hook's own isActive is tied to `active` (below) rather than left unconditionally
      // true, since a sibling overlay (ConfirmDialog, SessionPicker) has its own always-active
      // useInput holding raw mode whenever this one is deactivated - so it's still safe.
      if (key.return) {
        if (suppressNav) return; // CommandPalette owns Enter while it's open
        const submitted = value;
        if (submitted) {
          historyRef.current.push(submitted);
        }
        historyIndexRef.current = -1;
        draftRef.current = '';
        setValue('');
        setCursor(0);
        onSubmit(submitted);
        return;
      }
      if (key.upArrow) {
        if (suppressNav) return; // CommandPalette owns ↑/↓ while it's open
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
        if (historyIndexRef.current === -1) return;
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
      // Standard readline/bash conventions, since there's no dedicated Home/End key in
      // Ink's Key type (terminals send those as raw escape sequences it doesn't parse).
      if (key.ctrl && input === 'a') {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'e') {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        historyIndexRef.current = -1;
        setValue('');
        setCursor(0);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) {
        historyIndexRef.current = -1;
        setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive: active },
  );

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || ' ';
  const after = value.slice(cursor + 1);

  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : 'white'} paddingX={1}>
      <Text>
        {prompt}
        {before}
        {disabled ? at : <Text inverse>{at}</Text>}
        {after}
      </Text>
    </Box>
  );
}

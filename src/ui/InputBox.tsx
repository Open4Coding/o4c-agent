import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface InputBoxProps {
  prompt?: string;
  disabled?: boolean;
  onSubmit: (value: string) => void;
}

/**
 * A bordered, auto-growing input box. Ink's flexbox layout wraps the Text content and
 * grows the parent Box's height to fit as the line exceeds the terminal width - no
 * manual wrap-point math needed.
 */
export function InputBox({ prompt = '> ', disabled = false, onSubmit }: InputBoxProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  // Submitted-input recall (up/down arrow), kept local to the input box - it only
  // needs the raw strings that were submitted, not anything about how they resolved.
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1); // -1 = not currently browsing history
  const draftRef = useRef<string>(''); // what was being typed before browsing started

  useInput(
    (input, key) => {
      // Stay "active" unconditionally (below) so Ink keeps holding raw mode on stdin -
      // if every useInput hook in the tree goes inactive at once, Ink releases raw mode
      // and the terminal's own echo takes over, leaking typed characters onto the screen
      // instead of being captured here. Disabled just means "ignore it", not "stop listening".
      if (disabled) return;
      if (key.return) {
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
      if (key.ctrl || key.meta) return;
      if (input) {
        historyIndexRef.current = -1;
        setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive: true },
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

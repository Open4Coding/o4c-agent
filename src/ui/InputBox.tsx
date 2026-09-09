import React, { useState } from 'react';
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

  useInput(
    (input, key) => {
      if (key.return) {
        const submitted = value;
        setValue('');
        setCursor(0);
        onSubmit(submitted);
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
        setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive: !disabled },
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

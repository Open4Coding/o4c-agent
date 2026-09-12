import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ConfirmDialogProps {
  message: string;
  onResolve: (confirmed: boolean) => void;
}

/**
 * A generic yes/no confirmation, used before any destructive action (run_shell execution,
 * write_file overwrite, /wipe). Renders below the input box in place of it, matching Claude
 * Code's own permission-dialog pattern - a selector the user navigates, not free-text input.
 * Defaults to "No" selected: pressing Enter without moving the selection is always the safe,
 * cancelling choice, never the destructive one. Esc also cancels.
 */
export function ConfirmDialog({ message, onResolve }: ConfirmDialogProps) {
  const [selected, setSelected] = useState<'no' | 'yes'>('no');

  useInput((_input, key) => {
    if (key.upArrow || key.downArrow) {
      setSelected((s) => (s === 'no' ? 'yes' : 'no'));
    } else if (key.return) {
      onResolve(selected === 'yes');
    } else if (key.escape) {
      onResolve(false);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red" bold>
        {message}
      </Text>
      <Text color={selected === 'no' ? 'cyan' : undefined} inverse={selected === 'no'}>
        {selected === 'no' ? '> ' : '  '}No
      </Text>
      <Text color={selected === 'yes' ? 'cyan' : undefined} inverse={selected === 'yes'}>
        {selected === 'yes' ? '> ' : '  '}Yes
      </Text>
    </Box>
  );
}

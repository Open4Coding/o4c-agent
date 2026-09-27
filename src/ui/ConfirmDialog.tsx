import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ConfirmDialogProps {
  message: string;
  onResolve: (confirmed: boolean) => void;
  /** Real bug found via hands-on testing, 2026-09-26: with only `onResolve`, Escape and "arrow to
   * No, then Enter" were indistinguishable - both just declined the one call in front of you,
   * so a model that reacts to a decline by immediately trying something else (another run_shell
   * variant, say) just opened another confirm dialog right behind it, forever - "hitting Esc here
   * just lets every other next window open." Escape is a deliberate "stop everything" gesture,
   * not just "not this one" - called in addition to `onResolve(false)` specifically when Escape
   * (not a considered No) triggers the decline, so the caller can abort the whole turn instead of
   * only denying this single call and leaving the model free to keep trying. */
  onEscape?: () => void;
}

/**
 * A generic yes/no confirmation, used before any destructive action (run_shell execution,
 * write_file overwrite). Renders below the input box in place of it, matching Claude
 * Code's own permission-dialog pattern - a selector the user navigates, not free-text input.
 * Defaults to "No" selected: pressing Enter without moving the selection is always the safe,
 * cancelling choice, never the destructive one. Esc also cancels - and additionally signals
 * `onEscape`, since it means "stop," not just "not this one" (see that prop's own comment).
 */
export function ConfirmDialog({ message, onResolve, onEscape }: ConfirmDialogProps) {
  const [selected, setSelected] = useState<'no' | 'yes'>('no');

  useInput((_input, key) => {
    if (key.upArrow || key.downArrow) {
      setSelected((s) => (s === 'no' ? 'yes' : 'no'));
    } else if (key.return) {
      onResolve(selected === 'yes');
    } else if (key.escape) {
      onResolve(false);
      onEscape?.();
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

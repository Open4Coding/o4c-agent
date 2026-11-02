import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { diffColors, theme } from './theme.js';
import type { StyledDiffLine } from './diffStyle.js';

export interface ConfirmDialogProps {
  message: string;
  /**
   * A `write_file` diff, already clipped to fit and styled - checklist items 8 and 9, design doc
   * §9.6.
   *
   * Passed as structure rather than folded into `message` because the entire point is per-line
   * colour and `message` renders as a single `<Text>`. Optional, so every other confirmation path
   * (and every existing test) is untouched.
   */
  diff?: readonly StyledDiffLine[];
  /** Shown after "Yes" (e.g. `this stops the current process`) so what Yes does is spelled out next to the
   * choice itself. */
  yesNote?: string;
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
  /**
   * The four-way tool confirmation (plan 0006 C2): when set, the dialog offers No, Yes, "Yes, and
   * always allow", and "No, and tell the model why" (which asks for a one-line reason), and answers
   * here instead of `onResolve`. Hotkeys y / n / a / t.
   */
  onChoice?: (choice: ConfirmChoice, reason?: string) => void;
  /** What "always allow" covers, e.g. `run_shell(npm test*)`. */
  alwaysLabel?: string;
}

export type ConfirmChoice = 'no' | 'yes' | 'always' | 'tell';

/**
 * A generic yes/no confirmation, used before any destructive action (run_shell execution,
 * write_file overwrite). Renders below the input box in place of it, matching Claude
 * Code's own permission-dialog pattern - a selector the user navigates, not free-text input.
 * Defaults to "No" selected: pressing Enter without moving the selection is always the safe,
 * cancelling choice, never the destructive one. Esc also cancels - and additionally signals
 * `onEscape`, since it means "stop," not just "not this one" (see that prop's own comment).
 */
export function ConfirmDialog({ message, diff, yesNote, onResolve, onEscape, onChoice, alwaysLabel }: ConfirmDialogProps) {
  const choices: readonly ConfirmChoice[] = onChoice ? ['no', 'yes', 'always', 'tell'] : ['no', 'yes'];
  const [selected, setSelected] = useState<ConfirmChoice>('no');
  // 'tell': a one-line reason being typed (C2); undefined while choosing.
  const [reason, setReason] = useState<string | undefined>(undefined);
  // The round border and paddingX={1} take two columns each side.
  const innerWidth = Math.max(10, (process.stdout.columns ?? 80) - 4);

  const choose = (choice: ConfirmChoice) => {
    if (onChoice) {
      if (choice === 'tell') setReason('');
      else onChoice(choice);
    } else {
      onResolve(choice === 'yes');
    }
  };

  useInput((input, key) => {
    if (reason !== undefined) {
      // Typing the reason: Enter sends it with the "no", Esc goes back to the choices.
      if (key.return) onChoice?.('tell', reason);
      else if (key.escape) setReason(undefined);
      else if (key.backspace || key.delete) setReason((r) => (r ?? '').slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setReason((r) => `${r ?? ''}${input}`);
      return;
    }
    if (key.upArrow || key.downArrow) {
      setSelected((s) => {
        const i = choices.indexOf(s);
        return choices[(i + (key.downArrow ? 1 : choices.length - 1)) % choices.length]!;
      });
    } else if (key.return) {
      choose(selected);
    } else if (key.escape) {
      if (onChoice) onChoice('no');
      else onResolve(false);
      onEscape?.();
    } else {
      // Hotkeys (C2): y / n, and a / t where those choices exist.
      const hot = ({ y: 'yes', n: 'no', a: 'always', t: 'tell' } as const)[input?.toLowerCase() as 'y' | 'n' | 'a' | 't'];
      if (hot && choices.includes(hot)) choose(hot);
    }
  });

  const label: Record<ConfirmChoice, string> = {
    no: 'No',
    yes: `Yes${yesNote ? ` — ${yesNote}` : ''}`,
    always: `Yes, and always allow ${alwaysLabel ?? 'this'}`,
    tell: 'No, and tell the model why',
  };
  const key: Record<ConfirmChoice, string> = { no: 'n', yes: 'y', always: 'a', tell: 't' };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red" bold>
        {message}
      </Text>
      {diff && diff.length > 0 ? (
        <Box flexDirection="column">
          {diff.map((line, i) => (
            // Index keys: these rows are a static snapshot rebuilt whenever the dialog changes, and
            // a diff line has no identity of its own to key on.
            <DiffRow key={i} line={line} width={innerWidth} />
          ))}
        </Box>
      ) : null}
      {reason !== undefined ? (
        <Text>
          Why not? (Enter sends, Esc goes back): <Text color="cyan">{reason}</Text>
          <Text inverse> </Text>
        </Text>
      ) : (
        choices.map((c) => (
          <Text key={c} color={selected === c ? 'cyan' : undefined} inverse={selected === c}>
            {selected === c ? '> ' : '  '}
            {label[c]} <Text dimColor>({key[c]})</Text>
          </Text>
        ))
      )}
    </Box>
  );
}

/**
 * One diff row: gutter, marker, then the code. A changed line's background is carried to the
 * dialog's edge with padding, as Claude Code does - a background that stops where the text stops
 * makes a short line look like a highlighted word rather than a changed line. A row too long to fit
 * is left to wrap; its continuation keeps the background only under the text.
 *
 * The marker is part of the text, not only the colour: a terminal without colour, a copied-out
 * transcript, and this project's own frame assertions (which strip colour entirely - see theme.ts)
 * all still have to show which side a line is on.
 */
function DiffRow({ line, width }: { line: StyledDiffLine; width: number }) {
  const markerColor = line.kind === 'added' ? theme.ok : line.kind === 'removed' ? theme.error : diffColors.gutter;
  const used = stringWidth(`${line.gutter} ${line.marker}`) + line.segments.reduce((n, s) => n + stringWidth(s.text), 0);
  const pad = line.lineBackground ? Math.max(0, width - used) : 0;
  return (
    <Text>
      <Text color={diffColors.gutter}>{line.gutter} </Text>
      <Text color={markerColor} backgroundColor={line.lineBackground}>
        {line.marker}
      </Text>
      {line.segments.map((s, i) => (
        <Text key={i} color={s.color ?? theme.text} backgroundColor={s.backgroundColor}>
          {s.text}
        </Text>
      ))}
      {pad > 0 ? <Text backgroundColor={line.lineBackground}>{' '.repeat(pad)}</Text> : null}
    </Text>
  );
}

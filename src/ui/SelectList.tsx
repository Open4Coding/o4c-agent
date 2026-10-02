import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import stringWidth from 'string-width';

/** Width of the marker column: a row's first line is `> ` (selected) or two blanks, then its text. */
export const MARKER_WIDTH = 2;

/** Where a row's continuation lines start, counted from the left edge of the list's content. Two cells
 * further in than the first line's text (which starts at MARKER_WIDTH), so a wrapped line reads as a
 * continuation of the row above rather than as the start of a new row - at MARKER_WIDTH it lined up
 * exactly under the first line's text and was easy to mistake for a row of its own when scrolling. */
export const CONTINUATION_INDENT = 4;

/** Border (2) plus one cell of padding on each side (2): what the list box takes from the terminal width. */
export const LIST_CHROME_WIDTH = 4;

/**
 * Wraps one row's text into lines: the first line has `firstWidth` cells of room, every later line
 * `continuationWidth`. Greedy word wrap measured in terminal cells (wide characters count double); a word
 * that is longer than a whole line is split. Done here rather than left to the terminal because Ink cannot
 * indent only the continuation lines of auto-wrapped text, and a hanging indent is the whole point.
 */
export function wrapRow(text: string, firstWidth: number, continuationWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  let capacity = Math.max(1, firstWidth);
  const endLine = () => {
    lines.push(current);
    current = '';
    currentWidth = 0;
    capacity = Math.max(1, continuationWidth);
  };

  for (const word of text.replace(/\s*\n\s*/g, ' ').split(' ')) {
    const width = stringWidth(word);
    const needed = currentWidth === 0 ? width : currentWidth + 1 + width;
    if (needed <= capacity) {
      current = currentWidth === 0 ? word : `${current} ${word}`;
      currentWidth = needed;
      continue;
    }
    if (currentWidth > 0) endLine();
    if (width <= capacity) {
      current = word;
      currentWidth = width;
      continue;
    }
    for (const char of Array.from(word)) {
      const charWidth = stringWidth(char);
      if (currentWidth + charWidth > capacity) endLine();
      current += char;
      currentWidth += charWidth;
    }
  }
  if (current !== '' || lines.length === 0) lines.push(current);
  return lines;
}

export interface SelectListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  /** The row's plain text. The list wraps it itself (see `wrapRow`) and draws the `> ` marker, so a
   * caller never renders a marker or controls the wrapping. */
  rowText: (item: T) => string;
  /** Color for all of a row's lines (a mode's own color, the highlight color on the selected row).
   * Default: the terminal's normal color. */
  rowColor?: (item: T, selected: boolean) => string | undefined;
  onSelect: (item: T) => void;
  onCancel?: () => void;
  maxVisible?: number;
  title?: string;
  borderColor?: string;
  emptyMessage?: string;
  /** Which item is highlighted when the list first opens (e.g. the currently-active mode in a
   * mode picker), instead of always starting at the top. Default 0. Clamped to a valid index. */
  initialIndex?: number;
}

const DEFAULT_MAX_VISIBLE = 20;

/**
 * A generic scrollable, arrow-key-navigable selection list - the shared primitive behind
 * /resume's session picker, the "/" command palette and every other dropdown / slash-choice window,
 * meant to be reused by any future list-selection UI. The caller supplies already sorted/filtered
 * items; this component owns navigation, scrolling past `maxVisible`, the "N more above/below"
 * overflow indicators, and how rows look.
 *
 * Row contract (every list, now and in future): supply each row's text with `rowText`; the list draws
 * the marker and wraps long rows with a hanging indent (continuation lines at CONTINUATION_INDENT).
 * Keep a row's description to 1-3 lines (3 only in extreme cases) - src/test/pickerRows.test.ts
 * enforces both that and the no-own-marker rule.
 */
export function SelectList<T>({
  items,
  getKey,
  rowText,
  rowColor,
  onSelect,
  onCancel,
  maxVisible = DEFAULT_MAX_VISIBLE,
  title,
  borderColor = 'cyan',
  emptyMessage = 'Nothing to show.',
  initialIndex = 0,
}: SelectListProps<T>) {
  const { columns } = useWindowSize();
  const clampedInitial = Math.max(0, Math.min(initialIndex, items.length - 1));
  const [selectedIndex, setSelectedIndex] = useState(clampedInitial);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Reset to the top whenever the underlying item set actually changes (e.g. a live-filtered
  // list narrowing as the user types) - otherwise the selection could point past the end, or
  // land on a now-unrelated item.
  const itemsKey = items.map(getKey).join(' ');
  useEffect(() => {
    setSelectedIndex(clampedInitial);
    setScrollOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  useInput((_input, key) => {
    if (items.length === 0) {
      if (key.escape) onCancel?.();
      return;
    }
    if (key.upArrow) {
      const next = Math.max(0, selectedIndex - 1);
      setSelectedIndex(next);
      if (next < scrollOffset) setScrollOffset(next);
    } else if (key.downArrow) {
      const next = Math.min(items.length - 1, selectedIndex + 1);
      setSelectedIndex(next);
      if (next >= scrollOffset + maxVisible) setScrollOffset(next - maxVisible + 1);
    } else if (key.return) {
      onSelect(items[selectedIndex]);
    } else if (key.escape) {
      onCancel?.();
    }
  });

  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text dimColor>{emptyMessage}</Text>
      </Box>
    );
  }

  const inner = Math.max(MARKER_WIDTH + 1, columns - LIST_CHROME_WIDTH);
  const visible = items.slice(scrollOffset, scrollOffset + maxVisible);
  const moreAbove = scrollOffset;
  const moreBelow = Math.max(0, items.length - (scrollOffset + maxVisible));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      {title ? (
        <Text bold color={borderColor}>
          {title}
        </Text>
      ) : null}
      {moreAbove > 0 ? <Text dimColor>↑ {moreAbove} more above</Text> : null}
      {visible.map((item, i) => {
        const isSelected = scrollOffset + i === selectedIndex;
        const color = rowColor?.(item, isSelected);
        const lines = wrapRow(rowText(item), inner - MARKER_WIDTH, inner - CONTINUATION_INDENT);
        return (
          <Box key={getKey(item)} flexDirection="column">
            {lines.map((line, lineIndex) => (
              <Text key={lineIndex} color={color} inverse={isSelected}>
                {lineIndex === 0 ? (isSelected ? '> ' : '  ') : ' '.repeat(CONTINUATION_INDENT)}
                {line}
              </Text>
            ))}
          </Box>
        );
      })}
      {moreBelow > 0 ? <Text dimColor>↓ {moreBelow} more below</Text> : null}
    </Box>
  );
}

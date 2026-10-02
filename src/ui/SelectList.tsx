import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface SelectListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, selected: boolean) => React.ReactNode;
  onSelect: (item: T) => void;
  onCancel?: () => void;
  maxVisible?: number;
  title?: string;
  borderColor?: string;
  emptyMessage?: string;
  /** Color for the `> ` marker cell of a row, so it can match the row's own color (a mode's color, the
   * highlight color on the selected row). The marker is drawn HERE, never by `renderItem`. */
  markerColor?: (item: T, selected: boolean) => string | undefined;
  /** Which item is highlighted when the list first opens (e.g. the currently-active mode in a
   * mode picker), instead of always starting at the top. Default 0. Clamped to a valid index. */
  initialIndex?: number;
}

const DEFAULT_MAX_VISIBLE = 20;

/** Width of the marker column. Every row's text starts this many cells in, and when a row wraps its
 * continuation lines start at the same column (a hanging indent), so a long description never wraps
 * back under the `>`. */
export const MARKER_WIDTH = 2;

/**
 * Row contract (shared by every dropdown / slash-choice window, now and in future): `renderItem` returns
 * ONLY the row's content - never its own `> ` marker. This component draws the marker in a fixed column
 * and wraps the content beside it, so wrapped lines hang 2 cells in under the first character of the text.
 * Keep a row's description to 1-3 lines (3 only in extreme cases) - src/test/pickerRows.test.ts enforces it.
 *
 * A generic scrollable, arrow-key-navigable selection list - the shared primitive behind
 * /resume's session picker and the "/" command palette, meant to be reused by any future
 * list-selection UI (config pickers, plugin-owned lists, etc). The caller supplies already
 * sorted/filtered items; this component only owns navigation, scrolling past `maxVisible`, and
 * the "N more above/below" overflow indicators.
 */
export function SelectList<T>({
  items,
  getKey,
  renderItem,
  onSelect,
  onCancel,
  maxVisible = DEFAULT_MAX_VISIBLE,
  title,
  borderColor = 'cyan',
  emptyMessage = 'Nothing to show.',
  initialIndex = 0,
  markerColor,
}: SelectListProps<T>) {
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
        return (
          <Box key={getKey(item)}>
            <Box flexShrink={0} width={MARKER_WIDTH}>
              <Text color={markerColor?.(item, isSelected)} inverse={isSelected}>
                {isSelected ? '> ' : '  '}
              </Text>
            </Box>
            <Box flexShrink={1} flexGrow={1}>
              {renderItem(item, isSelected)}
            </Box>
          </Box>
        );
      })}
      {moreBelow > 0 ? <Text dimColor>↓ {moreBelow} more below</Text> : null}
    </Box>
  );
}

import React from 'react';
import { Text } from 'ink';
import { MODES, type Mode } from './modePolicy.js';
import { SelectList } from './SelectList.js';

export interface ModePickerProps {
  currentMode: Mode;
  onSelect: (mode: Mode) => void;
  onCancel: () => void;
}

/** The `/mode` picker - built on the generic SelectList, opening with the currently-active mode
 * already highlighted rather than always defaulting to the top of the list. */
export function ModePicker({ currentMode, onSelect, onCancel }: ModePickerProps) {
  const currentIndex = MODES.findIndex((m) => m.mode === currentMode);
  return (
    <SelectList
      items={MODES}
      getKey={(m) => m.mode}
      title="Choose a mode (↑/↓ to choose, Enter to select, Esc to cancel):"
      initialIndex={currentIndex >= 0 ? currentIndex : 0}
      onSelect={(m) => onSelect(m.mode)}
      onCancel={onCancel}
      renderItem={(m, selected) => (
        <Text color={m.color} inverse={selected}>
          {selected ? '> ' : '  '}
          {m.label}
          {m.mode === currentMode ? ' (current)' : ''}
        </Text>
      )}
    />
  );
}

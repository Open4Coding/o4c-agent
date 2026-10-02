import React from 'react';
import { Text } from 'ink';
import type { CommandInfo } from './slashCommand.js';
import { SelectList } from './SelectList.js';

export interface CommandPaletteProps {
  commands: readonly CommandInfo[];
  onSelect: (command: CommandInfo) => void;
  onCancel: () => void;
  /** The configurable "/" highlight color (default amber, /config-highlightcolor) - see
   * App.tsx's own doc comment on the prop it threads this down from. */
  highlightColor: string;
}

/**
 * The "/" live command menu - shows every command matching what's typed so far, alphabetically,
 * narrowing as more is typed (see `matchCommands` in slashCommand.ts). Built on the generic
 * SelectList; the input box stays active underneath while this is open (unlike /resume's picker
 * or a confirmation dialog, which take over input entirely) so typing keeps refining the filter.
 */
export function CommandPalette({ commands, onSelect, onCancel, highlightColor }: CommandPaletteProps) {
  return (
    <SelectList
      items={commands}
      getKey={(c) => c.name}
      maxVisible={20}
      borderColor={highlightColor}
      markerColor={(_, selected) => (selected ? highlightColor : undefined)}
      onSelect={onSelect}
      onCancel={onCancel}
      renderItem={(c, selected) => {
        const names = [c.name, ...(c.aliases ?? [])].join(', ');
        return (
          <Text color={selected ? highlightColor : undefined} inverse={selected}>
            {names} — {c.description}
          </Text>
        );
      }}
    />
  );
}

import React from 'react';
import { Text } from 'ink';
import { SelectList } from './SelectList.js';
import type { CommandInfo } from './slashCommand.js';

export interface CommandFamilyPickerProps {
  title: string;
  commands: readonly CommandInfo[];
  onSelect: (command: CommandInfo) => void;
  onCancel: () => void;
}

/**
 * The picker behind `/set` (every `/set-*` command) and, later, `/config` (every `/config-*`
 * command) - browsing a whole hidden command family at once, since neither family shows up in
 * the main "/" palette (see `CommandInfo.hidden`'s doc comment in slashCommand.ts). Selecting an
 * entry doesn't run it directly - the caller decides what "select" means (e.g. App.tsx prefills
 * the input box with the command's name so the user can type its argument before submitting),
 * same separation `/mode`'s picker keeps from `/mode` itself.
 */
export function CommandFamilyPicker({ title, commands, onSelect, onCancel }: CommandFamilyPickerProps) {
  return (
    <SelectList
      items={commands}
      getKey={(c) => c.name}
      title={title}
      onSelect={onSelect}
      onCancel={onCancel}
      renderItem={(c, selected) => (
        <Text inverse={selected}>
          {selected ? '> ' : '  '}
          {c.name} — {c.description}
        </Text>
      )}
    />
  );
}

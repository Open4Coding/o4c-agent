import React from 'react';
import { Text } from 'ink';
import type { SessionView } from './formatEntries.js';
import { SelectList } from './SelectList.js';

/** Which config tier the picker is editing: the project (`/set-sessionview`, `/set-local-sessionview`)
 * or this machine (`/set-global-sessionview`). */
export type SessionViewScope = 'local' | 'global';

/** `default` is only offered for the project tier: it copies the current global value into the
 * project (a one-time copy, no live link afterwards). */
export type SessionViewChoice = 'default' | SessionView;

export interface SessionViewRow {
  choice: SessionViewChoice;
  label: string;
  description: string;
}

/** The picklist rows for a tier, in display order. The global tier has no `default` row - it would
 * copy the global value onto itself. */
export function sessionViewRows(scope: SessionViewScope, globalValue: SessionView): SessionViewRow[] {
  const rows: SessionViewRow[] = [];
  if (scope === 'local') {
    rows.push({
      choice: 'default',
      label: 'default (global)',
      description: `use this machine's global choice, currently ${globalValue}`,
    });
  }
  rows.push(
    {
      choice: 'compact',
      label: 'compact',
      description: 'shortened: think 1,500 chars, tool arguments 300, results 200, long tool runs collapsed',
    },
    { choice: 'full', label: 'full', description: 'everything the session saved, nothing cut' },
  );
  return rows;
}

/** Which row opens highlighted: the tier's own stored value if it has one, otherwise the first row
 * (`default (global)` for the project, `compact` for the machine). */
export function initialRowIndex(rows: readonly SessionViewRow[], storedValue: SessionView | undefined): number {
  if (!storedValue) return 0;
  const index = rows.findIndex((r) => r.choice === storedValue);
  return index >= 0 ? index : 0;
}

export interface SessionViewPickerProps {
  scope: SessionViewScope;
  /** The value in effect for this tier right now (the project's own value, else the global one) -
   * marks the matching row `(current)`. */
  currentValue: SessionView;
  /** This tier's own stored value, if any - decides which row opens highlighted. */
  storedValue: SessionView | undefined;
  /** The global value, shown in the `default (global)` row. */
  globalValue: SessionView;
  onSelect: (choice: SessionViewChoice) => void;
  onCancel: () => void;
  highlightColor: string;
}

/** The `/set-sessionview` picklist - same look and keys as the `/mode` picker, built on SelectList. */
export function SessionViewPicker({
  scope,
  currentValue,
  storedValue,
  globalValue,
  onSelect,
  onCancel,
  highlightColor,
}: SessionViewPickerProps) {
  const rows = sessionViewRows(scope, globalValue);
  return (
    <SelectList
      items={rows}
      getKey={(r) => r.choice}
      title={`Choose the session view${scope === 'global' ? ' (global)' : ''} (↑/↓ to choose, Enter to select, Esc to cancel):`}
      initialIndex={initialRowIndex(rows, storedValue)}
      borderColor={highlightColor}
      onSelect={(r) => onSelect(r.choice)}
      onCancel={onCancel}
      renderItem={(r, selected) => (
        <Text inverse={selected}>
          {r.label} — {r.description}
          {r.choice === currentValue ? ' (current)' : ''}
        </Text>
      )}
    />
  );
}

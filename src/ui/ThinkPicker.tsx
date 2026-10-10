import React from 'react';
import { SelectList } from './SelectList.js';
import {
  DEFAULT_THINK_LEVEL,
  THINK_LEVELS,
  THINK_LEVEL_INFO,
  effectiveThinkLevel,
  type ThinkCaps,
  type ThinkLevel,
} from '../agent/thinkLevel.js';

export interface ThinkPickerProps {
  currentLevel: ThinkLevel;
  /** What this model's template actually honours. A level the model cannot deliver is still listed -
   * hiding rows would make the menu change shape per model - but it is labelled with what will
   * really happen, so the list never silently lies. */
  caps: ThinkCaps;
  onSelect: (level: ThinkLevel) => void;
  onCancel: () => void;
  highlightColor: string;
}

/**
 * The `/think` picker - the same shape as `/mode`'s, built on the generic `SelectList` so marker
 * column, wrapping and the continuation indent all come from one place (CLAUDE.md's picker rules;
 * `src/test/pickerRows.test.ts` fails on a picker that draws its own marker or writes a row too
 * long to fit at 100 columns).
 *
 * Opens on the level already in effect rather than at the top, so Enter is a no-op and the list
 * doubles as "what am I set to right now?".
 */
export function ThinkPicker({ currentLevel, caps, onSelect, onCancel, highlightColor }: ThinkPickerProps) {
  const items = THINK_LEVELS.map((level) => THINK_LEVEL_INFO[level]);
  const currentIndex = THINK_LEVELS.indexOf(currentLevel);

  return (
    <SelectList
      items={items}
      getKey={(i) => i.level}
      title="Choose a thinking level (↑/↓ to choose, Enter to select, Esc to cancel):"
      initialIndex={currentIndex >= 0 ? currentIndex : 0}
      borderColor={highlightColor}
      onSelect={(i) => onSelect(i.level)}
      onCancel={onCancel}
      rowText={(i) => {
        const effective = effectiveThinkLevel(i.level, caps);
        // Only ever appended when the model genuinely cannot deliver the row's own level - on a
        // model with the full set (anything with a reasoning budget) no row carries this at all.
        const fallback = effective === i.level ? '' : ` (this model: ${THINK_LEVEL_INFO[effective].label})`;
        const current = i.level === currentLevel ? ' (current)' : '';
        return `${i.label} — ${i.description}${fallback}${current}`;
      }}
    />
  );
}


/** Which config tier `/set-think` is editing: the project (`/set-think`, `/set-local-think`) or
 * this machine (`/set-global-think`). Distinct from `/think`, which changes only the live session
 * and persists wherever the level already lives. */
export type ThinkScope = 'local' | 'global';

/** `default` clears this tier's stored level instead of pinning one. */
export type ThinkScopeChoice = 'default' | ThinkLevel;

export interface ThinkScopeRow {
  choice: ThinkScopeChoice;
  label: string;
  description: string;
}

/**
 * The picklist rows for a tier, in display order.
 *
 * The `default` row deliberately does NOT behave like `/set-sessionview`'s, which copies the
 * global value into the project as a one-time snapshot. Here it removes the stored level, so the
 * tier falls through to the next one down - the project to the machine, the machine to o4c's
 * built-in default. That difference exists because the copy semantics have a trap this setting hit
 * in practice (2026-10-09): a level stored once was impossible to unset from inside o4c, it won
 * every launch, and copy-on-trust then seeded it into every project trusted afterwards, so even
 * deleting the project directory brought it back. Clearing is the only way back to the default,
 * and a setting you cannot return to its default is a setting that eventually traps someone.
 */
export function thinkScopeRows(scope: ThinkScope, globalLevel: ThinkLevel | undefined): ThinkScopeRow[] {
  const fallback =
    scope === 'local'
      ? `this machine's choice, currently ${globalLevel ? THINK_LEVEL_INFO[globalLevel].label : THINK_LEVEL_INFO[DEFAULT_THINK_LEVEL].label}`
      : `o4c's built-in default, ${THINK_LEVEL_INFO[DEFAULT_THINK_LEVEL].label}`;
  const rows: ThinkScopeRow[] = [
    {
      choice: 'default',
      label: 'default',
      description: `store nothing here and follow ${fallback}`,
    },
  ];
  for (const level of THINK_LEVELS) {
    rows.push({ choice: level, label: THINK_LEVEL_INFO[level].label, description: THINK_LEVEL_INFO[level].description });
  }
  return rows;
}

/** Which row opens highlighted: this tier's own stored level, else `default` (the first row), which
 * is also what the tier is doing when it has stored nothing. */
export function thinkScopeInitialIndex(rows: readonly ThinkScopeRow[], storedLevel: ThinkLevel | undefined): number {
  if (!storedLevel) return 0;
  const index = rows.findIndex((r) => r.choice === storedLevel);
  return index >= 0 ? index : 0;
}

export interface ThinkScopePickerProps {
  scope: ThinkScope;
  /** This tier's own stored level, if any - decides which row opens highlighted. */
  storedLevel: ThinkLevel | undefined;
  /** The global tier's stored level, named in the `default` row for the project tier. */
  globalLevel: ThinkLevel | undefined;
  caps: ThinkCaps;
  onSelect: (choice: ThinkScopeChoice) => void;
  onCancel: () => void;
  highlightColor: string;
}

/**
 * The `/set-think` picklist. Same rows as `/think`'s, with the `default` row on top and a title
 * that says which tier is being written - and, unlike `/think`, choosing here changes nothing
 * about the running session: it is read at the start of the next one.
 */
export function ThinkScopePicker({
  scope,
  storedLevel,
  globalLevel,
  caps,
  onSelect,
  onCancel,
  highlightColor,
}: ThinkScopePickerProps) {
  const rows = thinkScopeRows(scope, globalLevel);
  return (
    <SelectList
      items={rows}
      getKey={(r) => r.choice}
      title={`Thinking level for new sessions${scope === 'global' ? ' (global)' : ''} (↑/↓ to choose, Enter to select, Esc to cancel):`}
      initialIndex={thinkScopeInitialIndex(rows, storedLevel)}
      borderColor={highlightColor}
      onSelect={(r) => onSelect(r.choice)}
      onCancel={onCancel}
      rowText={(r) => {
        if (r.choice === 'default') {
          return `${r.label} — ${r.description}${storedLevel === undefined ? ' (current)' : ''}`;
        }
        const effective = effectiveThinkLevel(r.choice, caps);
        const note = effective === r.choice ? '' : ` (this model: ${THINK_LEVEL_INFO[effective].label})`;
        return `${r.label} — ${r.description}${note}${r.choice === storedLevel ? ' (current)' : ''}`;
      }}
    />
  );
}

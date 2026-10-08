import React from 'react';
import { SelectList } from './SelectList.js';
import { THINK_LEVELS, THINK_LEVEL_INFO, effectiveThinkLevel, type ThinkCaps, type ThinkLevel } from '../agent/thinkLevel.js';

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

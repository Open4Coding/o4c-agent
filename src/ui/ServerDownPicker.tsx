import React from 'react';
import { SelectList } from './SelectList.js';

/** How often o4c asks the server whether it has come up while the box is open. */
export const SERVER_POLL_MS = 5000;

/** `down`: nothing answered (powered off, still booting, wrong network). `loading`: it answered but is still
 * loading its model - on a small box on the back of a laptop that can take minutes. */
export type ServerWaitStatus = 'down' | 'loading';

export type ServerDownChoice = 'wait' | 'choose';

export interface ServerDownRow {
  choice: ServerDownChoice;
  text: string;
}

export function serverDownTitle(status: ServerWaitStatus): string {
  const head = status === 'loading' ? 'Server is loading the model' : 'Server is down';
  return `${head}, wait or choose another model (↑/↓ to choose, Enter to select, Esc to close):`;
}

/** The two rows. The Wait row says how often it is checking and how many checks have run, so a long wait
 * visibly keeps going. There is no time limit: a laptop-sized server can take minutes to load a model. */
export function serverDownRows(checks: number, pollMs: number = SERVER_POLL_MS): ServerDownRow[] {
  const every = `every ${Math.round(pollMs / 1000)} s`;
  const progress = checks > 0 ? `checked ${checks} time${checks === 1 ? '' : 's'}, ${every}` : `checking ${every}`;
  return [
    { choice: 'wait', text: `Wait for the server (${progress})` },
    { choice: 'choose', text: 'Choose another model' },
  ];
}

export interface ServerDownPickerProps {
  status: ServerWaitStatus;
  /** How many checks have run since the box opened. */
  checks: number;
  pollMs?: number;
  onSelect: (choice: ServerDownChoice) => void;
  onCancel: () => void;
  highlightColor: string;
}

/** The box shown below the input when the local server cannot answer: wait (the default) or pick another
 * model. Built on SelectList like every other dropdown. */
export function ServerDownPicker({ status, checks, pollMs, onSelect, onCancel, highlightColor }: ServerDownPickerProps) {
  return (
    <SelectList
      items={serverDownRows(checks, pollMs)}
      getKey={(r) => r.choice}
      title={serverDownTitle(status)}
      borderColor={highlightColor}
      onSelect={(r) => onSelect(r.choice)}
      onCancel={onCancel}
      rowText={(r) => r.text}
    />
  );
}

import React from 'react';
import { Text } from 'ink';
import type { SessionMeta } from '../session/sessionStore.js';
import { SelectList } from './SelectList.js';

export interface SessionPickerProps {
  sessions: readonly SessionMeta[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * `yyyy-mm-dd HH-mm-ss-mmm`, local time - a sortable, unambiguous timestamp prefix. Zero-padded
 * so a plain lexicographic sort of these strings orders the same as chronological order (newest
 * first when compared descending), even without a datetime-aware comparator.
 */
function sortableTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
  );
}

/** A newest-first, scrollable session list for /resume, built on the generic SelectList. */
export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  return (
    <SelectList
      items={sessions}
      getKey={(s) => s.id}
      title="Resume a session (↑/↓ to choose, Enter to resume, Esc to cancel):"
      maxVisible={20}
      onSelect={(s) => onSelect(s.id)}
      onCancel={onCancel}
      emptyMessage="No saved sessions to resume."
      renderItem={(s, selected) => (
        <Text color={selected ? 'cyan' : undefined} inverse={selected}>
          {selected ? '> ' : '  '}
          {sortableTimestamp(s.updatedAt)} — {relativeTime(s.updatedAt)} — {s.title} (
          {s.messageCount} messages)
        </Text>
      )}
    />
  );
}

import { normalize } from 'node:path';
import type { ContextEntry } from './contextEntry.js';

/**
 * File reads a later entry makes redundant (plan 0006 B10): an earlier `read_file` of a path that
 * was later read again in full (or the same lines again), or later rewritten whole by `write_file`.
 * The newest copy of every file is always kept, and an `edit_file` never supersedes anything - its
 * result shows only the changed lines, so the read before it is still the model's view of the rest.
 *
 * Returns the tool_call_ids of the superseded reads, oldest first. Only visible pairs whose read
 * succeeded count; what to do with them is the caller's decision (MicroCompact hides them).
 */
export function supersededReadIds(entries: readonly ContextEntry[]): string[] {
  const okResponse = new Set<string>();
  for (const e of entries) {
    if (e.type === 'ai' && e.sub_type === 'toolcallresponse' && e.tool_call_id && e.agent_visible !== false && !e.content.startsWith('Error')) {
      okResponse.add(e.tool_call_id);
    }
  }
  const key = (path: unknown) => {
    const p = normalize(String(path ?? ''));
    return process.platform === 'win32' ? p.toLowerCase() : p;
  };

  const open = new Map<string, Array<{ id: string; range: string }>>();
  const superseded: string[] = [];
  for (const e of entries) {
    if (e.type !== 'ai' || e.sub_type !== 'toolcall' || !e.tool_call_id || e.agent_visible === false) continue;
    let call: { name?: string; input?: Record<string, unknown> };
    try {
      call = JSON.parse(e.content) as typeof call;
    } catch {
      continue;
    }
    const input = call.input ?? {};
    if (typeof input.path !== 'string' || input.path === '') continue;
    if (call.name === 'read_file' && okResponse.has(e.tool_call_id)) {
      const path = key(input.path);
      const range = input.offset === undefined && input.limit === undefined ? 'all' : `${String(input.offset ?? 1)}:${String(input.limit ?? '')}`;
      const earlier = open.get(path) ?? [];
      // A full read supersedes every earlier read of the file; a partial one only the same lines.
      const keep = earlier.filter((r) => {
        const covered = range === 'all' || r.range === range;
        if (covered) superseded.push(r.id);
        return !covered;
      });
      open.set(path, [...keep, { id: e.tool_call_id, range }]);
    } else if (call.name === 'write_file') {
      const path = key(input.path);
      for (const r of open.get(path) ?? []) superseded.push(r.id);
      open.delete(path);
    }
  }
  return superseded;
}

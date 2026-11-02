import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CoreComponent } from '../agent/coreSeam.js';

/**
 * What the model has seen of each file this session (plan 0006 B9), so file edits are based on the
 * file as it is:
 *
 *  - `edit_file`, or `write_file` over an existing file, on a file not read (or written) in this
 *    session is refused: an edit made from memory or a guess is how a model mangles a file.
 *  - the same when the file changed on disk since the model last read or wrote it - a formatter,
 *    the user, a script - so the edit is not made against stale text.
 *  - an identical re-read of an unchanged file within the same turn gets a one-line stub instead
 *    of the whole file again (a second identical re-read right after a stub gets the content, so
 *    a model that really lost it is never stuck).
 *  - at the start of a turn, a note lists files changed outside o4c since the model last saw them.
 *
 * Persisted per session under `.o4c/filestate/`, because o4c reloads its process after most turns
 * and a map that forgot every read at each reload would refuse every edit in the next turn.
 */

interface Seen {
  mtimeMs: number;
  size: number;
}

interface Persisted {
  files: Record<string, Seen>;
  /** Files already reported as changed outside o4c, with the state that was reported. */
  reported: Record<string, Seen>;
}

const STUB_WINDOW = 20;

function statOf(path: string): Seen | undefined {
  try {
    const s = statSync(path);
    return s.isFile() ? { mtimeMs: s.mtimeMs, size: s.size } : undefined;
  } catch {
    return undefined;
  }
}

const same = (a: Seen | undefined, b: Seen | undefined) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

export interface FileStateOptions {
  /** `.o4c/filestate/<session>.json`; in memory only when undefined (an untrusted directory). */
  file?: string;
  cwd?: string;
}

export function fileStatePath(projectRoot: string | undefined, sessionId: string): string | undefined {
  return projectRoot ? join(projectRoot, '.o4c', 'filestate', `${sessionId}.json`) : undefined;
}

export function fileStateComponent(options: FileStateOptions = {}): CoreComponent & { seen(path: string): Seen | undefined } {
  const cwd = options.cwd ?? process.cwd();
  let state: Persisted = { files: {}, reported: {} };
  if (options.file) {
    try {
      state = { files: {}, reported: {}, ...(JSON.parse(readFileSync(options.file, 'utf-8')) as Partial<Persisted>) };
    } catch {
      // no file yet, or unreadable: start empty
    }
  }
  const save = () => {
    if (!options.file) return;
    try {
      mkdirSync(dirname(options.file), { recursive: true });
      writeFileSync(options.file, JSON.stringify(state));
    } catch {
      // losing this only costs a re-read; never fail a tool call over it
    }
  };
  const record = (abs: string) => {
    const now = statOf(abs);
    if (now) state.files[abs] = now;
    else delete state.files[abs];
    delete state.reported[abs];
    save();
  };

  // Turn-scoped, not persisted: identical reads in this turn, for the stub.
  let toolCalls = 0;
  const reads = new Map<string, { at: number; seen: Seen; stubbed: boolean }>();

  return {
    name: 'file-state',
    seen: (path: string) => state.files[resolve(cwd, path)],

    async aroundTool({ tool, input }, next) {
      toolCalls++;
      const name = tool.name;
      if (name !== 'read_file' && name !== 'edit_file' && name !== 'write_file') return next();
      const rel = String(input.path ?? '');
      if (!rel) return next();
      const abs = resolve(cwd, rel);
      const now = statOf(abs);

      if (name === 'edit_file' || (name === 'write_file' && now)) {
        const known = state.files[abs];
        if (now && !known) {
          return `Error: ${rel} has not been read in this session. Read it with read_file first, so the ${name === 'edit_file' ? 'edit is' : 'new content is'} based on what the file really contains. Nothing was changed.`;
        }
        if (now && known && !same(now, known)) {
          return `Error: ${rel} has changed on disk since you last read or wrote it (a command or another program changed it). Read it again before changing it. Nothing was changed.`;
        }
      }

      if (name === 'read_file' && now) {
        const key = `${abs}|${String(input.offset ?? '')}|${String(input.limit ?? '')}`;
        const last = reads.get(key);
        if (last && !last.stubbed && same(now, last.seen) && toolCalls - last.at <= STUB_WINDOW) {
          last.stubbed = true;
          return `[o4c] ${rel} has not changed since you read these same lines ${toolCalls - last.at} tool call(s) ago; that content is above, unchanged. (Read it again only if you no longer have it.)`;
        }
        const result = await next();
        if (!result.startsWith('Error')) {
          reads.set(key, { at: toolCalls, seen: now, stubbed: false });
          record(abs);
        }
        return result;
      }

      const result = await next();
      if (!result.startsWith('Error')) {
        record(abs);
        // A write changes what any earlier read of this file showed.
        for (const key of [...reads.keys()]) if (key.startsWith(`${abs}|`)) reads.delete(key);
      }
      return result;
    },

    turnNote() {
      reads.clear();
      toolCalls = 0;
      const changed: string[] = [];
      for (const [abs, seen] of Object.entries(state.files)) {
        const now = statOf(abs);
        if (same(now, seen)) continue;
        const reported = state.reported[abs];
        if (now ? same(now, reported) : reported?.size === -1) continue;
        state.reported[abs] = now ?? { mtimeMs: 0, size: -1 };
        changed.push(`${abs.startsWith(cwd) ? abs.slice(cwd.length + 1) : abs}${now ? '' : ' (deleted)'}`);
      }
      if (changed.length === 0) return undefined;
      save();
      return `[o4c] Changed outside o4c since you last read them: ${changed.join(', ')}. Read them again before relying on what you saw.`;
    },
  };
}

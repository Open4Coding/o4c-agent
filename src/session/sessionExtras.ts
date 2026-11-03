import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextEntry } from '../agent/contextEntry.js';
import { defaultLogsDir } from './runLog.js';
import type { SessionMeta, SessionStore } from './sessionStore.js';

/**
 * Plan 0006 E13: the small session conveniences - `--continue`, `/fork`, `/last-error`, the startup
 * health line and generated titles - kept together because each is a few lines over SessionStore.
 */

/** `o4c --continue`: the newest saved session in this project, if there is one. */
export async function latestSession(store: SessionStore): Promise<SessionMeta | undefined> {
  return (await store.readManifest())[0];
}

/** `/fork`: the conversation so far, saved under a new id; the original stays as it was. */
export async function forkSession(store: SessionStore, entries: readonly ContextEntry[], inputHistory: readonly string[], title: string): Promise<{ id: string; title: string }> {
  const id = await store.save(entries, undefined, inputHistory);
  const forkTitle = `${title} (fork)`;
  await store.rename(id, forkTitle);
  return { id, title: forkTitle };
}

/** One line under the banner on a fresh start: is the server up, what model, how much context. */
export function startupLine(s: { provider: string; status: string; model?: string; contextWindow?: number; last?: SessionMeta }): string {
  const server = s.provider === 'local' ? `server ${s.status}` : s.provider;
  const parts = [server, ...(s.model ? [`model ${s.model}`] : []), ...(s.contextWindow ? [`context ${s.contextWindow.toLocaleString()}`] : [])];
  const last = s.last ? `; last session "${s.last.title}" (o4c --continue, or /resume)` : '';
  return `${parts.join(' · ')}${last}`;
}

/** Remembered across the per-turn reload, beside crash.log. */
export function recordLastError(err: unknown, dir = defaultLogsDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(join(dir, 'last-error.json'), JSON.stringify({ ts: new Date().toISOString(), message, stack: err instanceof Error ? err.stack : undefined }), 'utf-8');
  } catch {
    // Diagnostics only.
  }
}

/** `/last-error`: the last failed request in full, then the end of crash.log. */
export function lastErrorReport(dir = defaultLogsDir(), crashLines = 3): string[] {
  const out: string[] = [];
  try {
    const e = JSON.parse(readFileSync(join(dir, 'last-error.json'), 'utf-8')) as { ts: string; message: string; stack?: string };
    out.push(`Last error (${e.ts}):`, `  ${e.message}`, ...(e.stack ? e.stack.split('\n').slice(1, 6).map((l) => `  ${l.trim()}`) : []));
  } catch {
    out.push('No request has failed yet.');
  }
  try {
    const lines = readFileSync(join(dir, 'crash.log'), 'utf-8').trim().split('\n').filter(Boolean).slice(-crashLines);
    if (lines.length) {
      out.push('', `crash.log (last ${lines.length}, in ${dir}):`);
      for (const l of lines) {
        try {
          const c = JSON.parse(l) as { ts: string; type: string; message: string };
          out.push(`  ${c.ts} ${c.type}: ${c.message}`);
        } catch {
          out.push(`  ${l.slice(0, 300)}`);
        }
      }
    }
  } catch {
    // No crash.log is the normal case.
  }
  return out;
}

/** Generated titles (off by default, config `generateTitles`): the request text, and the cleanup. */
export const GENERATE_TITLES_KEY = 'generateTitles';

export function titlePrompt(firstMessage: string): string {
  return `Give this conversation a title of 3 to 7 words. Output only the title - no quotes, no punctuation at the end.\n\n${firstMessage.slice(0, 2000)}`;
}

export function cleanTitle(text: string): string | undefined {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n')[0]!.replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').trim();
  return t && t.length <= 80 ? t : undefined;
}

